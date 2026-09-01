import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  assertProvenanceConsistent,
  decisionSafetyOf,
  isTestFixture,
  type DataProvenance,
  type DecisionSafety,
} from "@sae/core";
import type { SourceTier } from "@sae/providers";

import type { Database } from "../client";
import { decisions, featureObservations } from "../schema/decisions";
import { opportunities } from "../schema/opportunities";

/**
 * Schreibpfad fuer Entscheidungen und beobachtete Features.
 *
 * Eine Entscheidung ist hier ein eigenes Ereignis mit eigener Zeile. Vorher
 * existierte sie nur fluechtig: die Pipeline berechnete eine Kennung und warf
 * sie weg. Damit liess sich hinterher nicht sagen, welche beiden Gelegenheiten
 * aus derselben Entscheidung stammten — und genau das ist die Frage, auf die
 * dieses System hinauslaeuft.
 */

export interface CreateDecisionInput {
  readonly decisionKey: string;
  readonly tokenId: string;
  readonly decidedAt: Date;
  readonly strategyVersionId: string;
  readonly scoreEngineVersion: string;
  readonly decisionKind: "ENTER" | "WATCH" | "REJECT";
  readonly finalScore: number | null;
  readonly dataCompleteness: number;
  readonly featureSnapshotId: string;
  readonly provenance: DataProvenance;
}

export type CreateDecisionResult =
  | { readonly kind: "CREATED"; readonly decisionId: string }
  /** Derselbe Eingang lag schon vor: zweiter Lauf desselben Ereignisses. */
  | { readonly kind: "DUPLICATE"; readonly decisionId: string };

export interface FeatureObservationInput {
  readonly tokenId: string;
  readonly featureName: string;
  readonly value: number | boolean | string;
  readonly provider: string;
  readonly endpoint: string;
  /**
   * `null`, wenn der Anbieter keinen Beobachtungszeitpunkt liefert.
   *
   * Es wird KEINER konstruiert. Die Folge steht in `decisionSafety`, und die
   * Datenbank setzt sie durch.
   */
  readonly observedAt: Date | null;
  readonly receivedAt: Date;
  readonly sourceTier: SourceTier;
  readonly dataQuality: number;
  readonly schemaVersion: string;
  readonly adapterVersion: string;
  readonly snapshotId?: string | null;
  readonly decisionId?: string | null;
  readonly decisionTimestamp?: Date | null;
  readonly provenance: Pick<DataProvenance, "sourceType">;
}

/** Stabiler Schluessel eines Datenpunkts. Derselbe Punkt ergibt denselben Wert. */
export function observationKey(input: {
  readonly tokenId: string;
  readonly featureName: string;
  readonly provider: string;
  readonly observedAt: Date | null;
  readonly receivedAt: Date;
}): string {
  // Fehlt der Beobachtungszeitpunkt, traegt der Empfangszeitpunkt die
  // Unterscheidung: jede Abfrage erzeugt dann genau eine Beobachtung. Das ist
  // richtig, denn ohne Anbieterzeitpunkt IST der Abruf das Ereignis.
  const at = (input.observedAt ?? input.receivedAt).toISOString();
  return createHash("sha256")
    .update([input.tokenId, input.featureName, input.provider, at].join(" "))
    .digest("hex")
    .slice(0, 32);
}

export class DecisionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Legt eine Entscheidung an oder gibt die vorhandene zurueck.
   *
   * `UNIQUE (decision_key)` entscheidet, nicht ein vorheriges SELECT: zwei
   * gleichzeitige Worker bekommen dasselbe Ergebnis.
   */
  async create(input: CreateDecisionInput): Promise<CreateDecisionResult> {
    assertProvenanceConsistent(input.provenance);

    const inserted = await this.db
      .insert(decisions)
      .values({
        decisionKey: input.decisionKey,
        tokenId: input.tokenId,
        decidedAt: input.decidedAt,
        strategyVersionId: input.strategyVersionId,
        scoreEngineVersion: input.scoreEngineVersion,
        decisionKind: input.decisionKind,
        finalScore: input.finalScore,
        dataCompleteness: input.dataCompleteness,
        featureSnapshotId: input.featureSnapshotId,
        sourceType: input.provenance.sourceType,
        isTestFixture: isTestFixture(input.provenance.sourceType),
      })
      .onConflictDoNothing({ target: decisions.decisionKey })
      .returning({ id: decisions.id });

    const row = inserted[0];
    if (row !== undefined) return { kind: "CREATED", decisionId: row.id };

    const [existing] = await this.db
      .select({ id: decisions.id })
      .from(decisions)
      .where(eq(decisions.decisionKey, input.decisionKey))
      .limit(1);
    if (existing === undefined) {
      throw new Error("Entscheidung war doppelt und ist nicht auffindbar");
    }
    return { kind: "DUPLICATE", decisionId: existing.id };
  }

  /** Verknuepft eine Gelegenheit mit ihrer Entscheidung und zaehlt den Zweig. */
  async attachOpportunity(input: {
    readonly decisionId: string;
    readonly opportunityId: string;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(opportunities)
        .set({ decisionId: input.decisionId })
        // Nur setzen, wenn noch nichts dransteht: ein zweiter Lauf darf den
        // Zweigzaehler nicht erneut erhoehen.
        .where(
          sql`${opportunities.id} = ${input.opportunityId} and ${opportunities.decisionId} is null`,
        )
        .returning({ id: opportunities.id });

      if (updated.length === 0) return;
      await tx
        .update(decisions)
        .set({ branchCount: sql`${decisions.branchCount} + 1` })
        .where(eq(decisions.id, input.decisionId));
    });
  }

  async findByKey(decisionKey: string): Promise<typeof decisions.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(decisions)
      .where(eq(decisions.decisionKey, decisionKey))
      .limit(1);
    return row ?? null;
  }

  /** Alle Gelegenheiten einer Entscheidung: Auto und Manual. */
  async opportunitiesOf(decisionId: string): Promise<readonly { id: string; stream: string }[]> {
    return this.db
      .select({ id: opportunities.id, stream: opportunities.stream })
      .from(opportunities)
      .where(eq(opportunities.decisionId, decisionId));
  }
}

export class FeatureObservationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Schreibt eine Beobachtung.
   *
   * Die Einstufung `DECISION_SAFE` / `RESEARCH_ONLY` wird hier abgeleitet und
   * nicht vom Aufrufer gesetzt: die Regel gehoert an eine Stelle, nicht an jede
   * Schreibstelle. Die Datenbank prueft sie zusaetzlich.
   */
  async record(
    input: FeatureObservationInput,
  ): Promise<{ readonly kind: "RECORDED" | "DUPLICATE"; readonly safety: DecisionSafety }> {
    const safety = decisionSafetyOf({
      observedAt: input.observedAt,
      sourceType: input.provenance.sourceType,
    });

    const dedupeKey = observationKey({
      tokenId: input.tokenId,
      featureName: input.featureName,
      provider: input.provider,
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
    });

    const inserted = await this.db
      .insert(featureObservations)
      .values({
        tokenId: input.tokenId,
        featureName: input.featureName,
        valueNum: typeof input.value === "number" ? input.value : null,
        valueBool: typeof input.value === "boolean" ? input.value : null,
        valueText: typeof input.value === "string" ? input.value : null,
        provider: input.provider,
        endpoint: input.endpoint,
        observedAt: input.observedAt,
        receivedAt: input.receivedAt,
        // Kein geschaetztes Alter, wenn der Zeitpunkt fehlt.
        dataAgeMs:
          input.observedAt === null
            ? null
            : Math.max(0, input.receivedAt.getTime() - input.observedAt.getTime()),
        sourceTier: input.sourceTier,
        dataQuality: input.dataQuality,
        decisionSafety: safety,
        schemaVersion: input.schemaVersion,
        adapterVersion: input.adapterVersion,
        snapshotId: input.snapshotId ?? null,
        decisionId: input.decisionId ?? null,
        decisionTimestamp: input.decisionTimestamp ?? null,
        sourceType: input.provenance.sourceType,
        isTestFixture: isTestFixture(input.provenance.sourceType),
        dedupeKey,
      })
      .onConflictDoNothing({ target: featureObservations.dedupeKey })
      .returning({ id: featureObservations.id });

    return { kind: inserted.length > 0 ? "RECORDED" : "DUPLICATE", safety };
  }

  /** Beobachtungen einer Entscheidung. Grundlage der Herkunftsanalyse. */
  async forDecision(
    decisionId: string,
  ): Promise<readonly (typeof featureObservations.$inferSelect)[]> {
    return this.db
      .select()
      .from(featureObservations)
      .where(eq(featureObservations.decisionId, decisionId));
  }

  /**
   * Features, die eine Entscheidung tragen duerfen.
   *
   * Die Abfrage filtert nicht nachtraeglich, sie fragt nach dem, was die
   * Datenbank bereits als entscheidungsfaehig markiert hat.
   */
  async decisionSafeFor(
    tokenId: string,
  ): Promise<readonly (typeof featureObservations.$inferSelect)[]> {
    return this.db
      .select()
      .from(featureObservations)
      .where(
        sql`${featureObservations.tokenId} = ${tokenId}
            and ${featureObservations.decisionSafety} = 'DECISION_SAFE'`,
      );
  }
}
