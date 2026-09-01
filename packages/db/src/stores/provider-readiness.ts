import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client";
import {
  providerCapabilityStatus,
  providerRequests,
  type CAPABILITY_STATES,
  type IMPLEMENTATION_CONFIDENCES,
} from "../schema/provider-readiness";

/**
 * Reifegrad je (Anbieter, Faehigkeit) und die Messung echter Requests.
 *
 * Die wichtigste Eigenschaft dieses Stores ist eine Verweigerung: es gibt keine
 * Methode, die `production_verified` setzt, ohne einen echten HTTP-Status
 * vorzulegen. Ein Testlauf hat keinen. Damit kann kein Fixture einen Anbieter
 * als produktionsbereit markieren — nicht weil ein Filter es abfaengt, sondern
 * weil die Datenbank die Zeile sonst ablehnt.
 */

export type CapabilityState = (typeof CAPABILITY_STATES)[number];
export type ImplementationConfidence = (typeof IMPLEMENTATION_CONFIDENCES)[number];

export interface CapabilityStatusRow {
  readonly providerId: string;
  readonly capability: string;
  readonly state: CapabilityState;
  readonly implementationConfidence: ImplementationConfidence;
  readonly productionVerified: boolean;
  readonly lastSmokeTestAt: Date | null;
  readonly lastSmokeTestStatus: number | null;
  readonly lastSmokeTestDetail: string | null;
}

export interface ProviderRequestRecord {
  readonly providerId: string;
  readonly capability: string;
  readonly endpoint: string;
  readonly at: Date;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly success: boolean;
  readonly failureClass?: string | null;
  readonly failureReason?: string | null;
  readonly costUnits?: number | null;
  readonly tokensCovered?: number;
  readonly tokenId?: string | null;
  readonly pipelineStage?: string | null;
  readonly decisionId?: string | null;
  readonly schemaValid?: boolean | null;
}

export class ProviderReadinessStore {
  constructor(private readonly db: Database) {}

  /**
   * Legt den Ausgangszustand fest.
   *
   * `CONFIGURED` heisst nur: es steht eine Basis-URL in der Konfiguration. Es
   * heisst ausdruecklich nicht, dass jemals eine Antwort kam.
   */
  async declare(input: {
    readonly providerId: string;
    readonly capability: string;
    readonly implementationConfidence: ImplementationConfidence;
  }): Promise<void> {
    await this.db
      .insert(providerCapabilityStatus)
      .values({
        providerId: input.providerId,
        capability: input.capability,
        state: "CONFIGURED",
        implementationConfidence: input.implementationConfidence,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [providerCapabilityStatus.providerId, providerCapabilityStatus.capability],
        set: {
          implementationConfidence: input.implementationConfidence,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Traegt das Ergebnis eines ECHTEN Smoke-Tests ein.
   *
   * Der HTTP-Status ist Pflicht und der eigentliche Beweis. Ein 2xx setzt
   * `production_verified`; alles andere setzt es zurueck. Die Datenbank prueft
   * das zusaetzlich per CHECK, damit auch ein direkter Schreibzugriff nicht
   * daran vorbeikommt.
   */
  async recordSmokeTest(input: {
    readonly providerId: string;
    readonly capability: string;
    readonly at: Date;
    readonly httpStatus: number;
    readonly detail: string;
    /** Nur ein geprueftes Schema erlaubt den Schritt nach CAPABILITY_READY. */
    readonly schemaVerified: boolean;
  }): Promise<CapabilityStatusRow | null> {
    const passed = input.httpStatus >= 200 && input.httpStatus < 300;

    // Ein Fehlschlag befoerdert den Zustand NICHT — und stuft ihn auch nicht
    // herab. Ein 403 kann vom Anbieter kommen oder von einem Proxy dazwischen;
    // von hier aus ist das nicht unterscheidbar. Ihn als CONNECTED zu
    // verbuchen waere eine Behauptung ueber eine Verbindung, die es
    // moeglicherweise nie gab.
    const promotion: { state?: CapabilityState } = !passed
      ? {}
      : { state: input.schemaVerified ? "CAPABILITY_READY" : "CONNECTED" };

    const updated = await this.db
      .update(providerCapabilityStatus)
      .set({
        ...promotion,
        productionVerified: passed,
        lastSmokeTestAt: input.at,
        lastSmokeTestStatus: input.httpStatus,
        lastSmokeTestDetail: input.detail,
        ...(input.schemaVerified ? { implementationConfidence: "SCHEMA_VERIFIED" as const } : {}),
        updatedAt: input.at,
      })
      .where(
        and(
          eq(providerCapabilityStatus.providerId, input.providerId),
          eq(providerCapabilityStatus.capability, input.capability),
        ),
      )
      .returning();

    const row = updated[0];
    return row === undefined ? null : toRow(row);
  }

  async statusOf(providerId: string, capability: string): Promise<CapabilityStatusRow | null> {
    const [row] = await this.db
      .select()
      .from(providerCapabilityStatus)
      .where(
        and(
          eq(providerCapabilityStatus.providerId, providerId),
          eq(providerCapabilityStatus.capability, capability),
        ),
      )
      .limit(1);
    return row === undefined ? null : toRow(row);
  }

  async all(): Promise<readonly CapabilityStatusRow[]> {
    const rows = await this.db
      .select()
      .from(providerCapabilityStatus)
      .orderBy(providerCapabilityStatus.providerId, providerCapabilityStatus.capability);
    return rows.map(toRow);
  }

  /**
   * Faehigkeiten, die tatsaechlich benutzt werden duerfen.
   *
   * Die Bedingung ist bewusst streng: nur ein Anbieter mit echtem Smoke-Test
   * und geprueftem Schema kommt durch. `MARKET_DATA_PRIORITY` darf nichts
   * anderes aufnehmen.
   */
  async ready(capability: string): Promise<readonly string[]> {
    const rows = await this.db
      .select({ providerId: providerCapabilityStatus.providerId })
      .from(providerCapabilityStatus)
      .where(
        and(
          eq(providerCapabilityStatus.capability, capability),
          eq(providerCapabilityStatus.productionVerified, true),
          sql`${providerCapabilityStatus.state} in ('CAPABILITY_READY','PRODUCTION_ENABLED')`,
        ),
      );
    return rows.map((r) => r.providerId);
  }

  /** Eine Zeile je echtem Request. Grundlage der Kosten- und Latenzmessung. */
  async recordRequest(record: ProviderRequestRecord): Promise<void> {
    await this.db.insert(providerRequests).values({
      providerId: record.providerId,
      capability: record.capability,
      endpoint: record.endpoint,
      at: record.at,
      latencyMs: record.latencyMs,
      httpStatus: record.httpStatus,
      success: record.success,
      failureClass: record.failureClass ?? null,
      failureReason: record.failureReason ?? null,
      costUnits: record.costUnits ?? null,
      tokensCovered: record.tokensCovered ?? 1,
      tokenId: record.tokenId ?? null,
      pipelineStage: record.pipelineStage ?? null,
      decisionId: record.decisionId ?? null,
      schemaValid: record.schemaValid ?? null,
    });
  }

  /**
   * Messwerte je Anbieter und Faehigkeit.
   *
   * Perzentile statt Mittelwert: ein Durchschnitt glaettet genau den Aufruf
   * weg, der zwanzig Sekunden brauchte, und der ist der interessante.
   */
  async measurements(since: Date): Promise<
    readonly {
      readonly providerId: string;
      readonly capability: string;
      readonly requests: number;
      readonly errorRate: number;
      readonly latencyP50: number | null;
      readonly latencyP95: number | null;
      readonly schemaFailures: number;
      readonly costUnits: number | null;
      readonly tokensCovered: number;
    }[]
  > {
    return this.db
      .select({
        providerId: providerRequests.providerId,
        capability: providerRequests.capability,
        requests: sql<number>`count(*)::int`,
        errorRate: sql<number>`(count(*) filter (where not ${providerRequests.success}))::float / count(*)`,
        latencyP50: sql<number | null>`percentile_cont(0.5) within group (order by ${providerRequests.latencyMs})`,
        latencyP95: sql<number | null>`percentile_cont(0.95) within group (order by ${providerRequests.latencyMs})`,
        schemaFailures: sql<number>`(count(*) filter (where ${providerRequests.schemaValid} = false))::int`,
        costUnits: sql<number | null>`sum(${providerRequests.costUnits})`,
        tokensCovered: sql<number>`sum(${providerRequests.tokensCovered})::int`,
      })
      .from(providerRequests)
      .where(sql`${providerRequests.at} >= ${since}`)
      .groupBy(providerRequests.providerId, providerRequests.capability);
  }

  async recentRequests(limit = 50): Promise<readonly (typeof providerRequests.$inferSelect)[]> {
    return this.db
      .select()
      .from(providerRequests)
      .orderBy(desc(providerRequests.at))
      .limit(limit);
  }
}

function toRow(row: typeof providerCapabilityStatus.$inferSelect): CapabilityStatusRow {
  return {
    providerId: row.providerId,
    capability: row.capability,
    state: row.state,
    implementationConfidence: row.implementationConfidence,
    productionVerified: row.productionVerified,
    lastSmokeTestAt: row.lastSmokeTestAt,
    lastSmokeTestStatus: row.lastSmokeTestStatus,
    lastSmokeTestDetail: row.lastSmokeTestDetail,
  };
}
