import { and, eq, sql } from "drizzle-orm";
import {
  assertProvenanceConsistent,
  isTestFixture,
  opportunityStateMachine,
  type DataProvenance,
  type OpportunityState,
  type SizingMode,
  type TradingStream,
} from "@sae/core";

import type { Database } from "../client";
import {
  featureSnapshots,
  manualResponses,
  opportunities,
  opportunityOutcomes,
} from "../schema/opportunities";

/**
 * Schreibpfad fuer Gelegenheiten.
 *
 * Drei Eigenschaften, die diesen Pfad von einem `insert` unterscheiden:
 *
 * 1. **Eine Transaktion.** Feature-Snapshot und Gelegenheit entstehen zusammen
 *    oder gar nicht. Getrennt geschrieben hinterlaesst ein Absturz zwischen
 *    beiden entweder einen Snapshot, auf den nichts zeigt, oder — schlimmer —
 *    eine Gelegenheit ohne die Daten, gegen die entschieden wurde.
 * 2. **Idempotenz aus der Datenbank.** `UNIQUE (token_id, stream, decided_at)`
 *    entscheidet, nicht ein vorheriges `SELECT`. Zwei gleichzeitige Worker
 *    bekommen dasselbe Ergebnis.
 * 3. **Zustandswechsel mit Bedingung.** Jedes `UPDATE` traegt den erwarteten
 *    Ausgangszustand im `WHERE`. Wer dazwischenkommt, gewinnt nicht still —
 *    der zweite Aufruf meldet einen Konflikt.
 */

export interface FeatureSnapshotInput {
  readonly tokenId: string;
  readonly observedAt: Date;
  readonly features: Readonly<Record<string, unknown>>;
  readonly missingFields: readonly string[];
  readonly dataCompleteness: number;
  readonly scoreEngineVersion: string;
  readonly featureSetVersion: string;
  readonly inputHash: string;
}

export interface CreateOpportunityInput {
  readonly tokenId: string;
  /**
   * Woher die Daten stammen. Pflichtangabe.
   *
   * Bewusst kein Standardwert: eine Gelegenheit ohne benennbare Herkunft
   * duerfte gar nicht entstehen. Wer sie anlegt, muss sagen koennen, worauf
   * sie beruht.
   */
  readonly provenance: DataProvenance;
  readonly stream: TradingStream;
  readonly decisionKind: "ENTER" | "WATCH" | "REJECT";
  readonly finalScore: number | null;
  readonly reasons: readonly unknown[];
  readonly risks: readonly unknown[];
  readonly rejectionReasons: readonly unknown[];
  readonly strategyVersionId: string;
  readonly decidedAt: Date;
  readonly respondBy: Date | null;
  readonly snapshot: FeatureSnapshotInput;
}

export type CreateOpportunityResult =
  | { readonly kind: "CREATED"; readonly opportunityId: string; readonly snapshotId: string }
  | { readonly kind: "DUPLICATE"; readonly opportunityId: string };

export type TransitionResult =
  | { readonly kind: "OK"; readonly state: OpportunityState }
  | { readonly kind: "ILLEGAL"; readonly from: OpportunityState; readonly to: OpportunityState }
  | { readonly kind: "CONFLICT"; readonly expected: OpportunityState; readonly actual: OpportunityState | null };

export class OpportunityRepository {
  constructor(private readonly db: Database) {}

  /**
   * Legt Snapshot und Gelegenheit gemeinsam an.
   *
   * Der Snapshot wird zuerst geschrieben, weil die Gelegenheit ihn referenziert.
   * Existiert er schon (derselbe Token, dieselbe Beobachtungssekunde, dieselbe
   * Engine-Version), wird der vorhandene verwendet statt ein zweiter angelegt:
   * derselbe Entscheidungszustand zweimal gespeichert waere zweimal dieselbe
   * Wahrheit, und irgendwann laufen die beiden Kopien auseinander.
   */
  async create(input: CreateOpportunityInput): Promise<CreateOpportunityResult> {
    // Vor dem ersten Schreibzugriff: eine widerspruechliche Herkunft soll gar
    // keine Zeile erzeugen, nicht eine halb geschriebene Transaktion.
    assertProvenanceConsistent(input.provenance);

    return this.db.transaction(async (tx) => {
      const [snapshot] = await tx
        .insert(featureSnapshots)
        .values({
          tokenId: input.snapshot.tokenId,
          observedAt: input.snapshot.observedAt,
          features: input.snapshot.features as never,
          missingFields: [...input.snapshot.missingFields],
          dataCompleteness: input.snapshot.dataCompleteness,
          scoreEngineVersion: input.snapshot.scoreEngineVersion,
          featureSetVersion: input.snapshot.featureSetVersion,
          inputHash: input.snapshot.inputHash,
          sourceType: input.provenance.sourceType,
          sourceProvider: input.provenance.sourceProvider,
          sourceTier: input.provenance.sourceTier,
          sourceTimestamp: input.provenance.sourceTimestamp,
          isTestFixture: isTestFixture(input.provenance.sourceType),
        })
        .onConflictDoNothing()
        .returning({ id: featureSnapshots.id });

      const snapshotId =
        snapshot?.id ??
        (
          await tx
            .select({ id: featureSnapshots.id })
            .from(featureSnapshots)
            .where(
              and(
                eq(featureSnapshots.tokenId, input.snapshot.tokenId),
                eq(featureSnapshots.observedAt, input.snapshot.observedAt),
                eq(featureSnapshots.scoreEngineVersion, input.snapshot.scoreEngineVersion),
              ),
            )
            .limit(1)
        )[0]?.id;

      if (snapshotId === undefined) {
        // Kann nur passieren, wenn der Unique-Index nicht greift, wo er sollte.
        // Sichtbar scheitern statt eine Gelegenheit ohne Grundlage anzulegen.
        throw new Error("Feature-Snapshot konnte weder angelegt noch gefunden werden");
      }

      const [created] = await tx
        .insert(opportunities)
        .values({
          tokenId: input.tokenId,
          stream: input.stream,
          state: "OFFERED",
          decisionKind: input.decisionKind,
          finalScore: input.finalScore,
          reasons: [...input.reasons] as never,
          risks: [...input.risks] as never,
          rejectionReasons: [...input.rejectionReasons] as never,
          featureSnapshotId: snapshotId,
          strategyVersionId: input.strategyVersionId,
          decidedAt: input.decidedAt,
          respondBy: input.respondBy,
          sourceType: input.provenance.sourceType,
          isTestFixture: isTestFixture(input.provenance.sourceType),
        })
        .onConflictDoNothing({
          target: [opportunities.tokenId, opportunities.stream, opportunities.decidedAt],
        })
        .returning({ id: opportunities.id });

      if (created !== undefined) {
        return { kind: "CREATED" as const, opportunityId: created.id, snapshotId };
      }

      const [existing] = await tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.tokenId, input.tokenId),
            eq(opportunities.stream, input.stream),
            eq(opportunities.decidedAt, input.decidedAt),
          ),
        )
        .limit(1);

      if (existing === undefined) {
        throw new Error("Gelegenheit war doppelt und ist trotzdem nicht auffindbar");
      }
      return { kind: "DUPLICATE" as const, opportunityId: existing.id };
    });
  }

  /**
   * Zustandswechsel mit erwartetem Ausgangszustand.
   *
   * Erst der Automat (ist der Uebergang ueberhaupt erlaubt), dann die Datenbank
   * (steht die Zeile noch da, wo wir sie vermuten). Beides ist noetig: der
   * Automat kennt die Regeln, aber nicht die Nebenlaeufigkeit.
   */
  async transition(input: {
    readonly opportunityId: string;
    readonly from: OpportunityState;
    readonly to: OpportunityState;
    readonly at: Date;
  }): Promise<TransitionResult> {
    if (!opportunityStateMachine.canTransition(input.from, input.to)) {
      return { kind: "ILLEGAL", from: input.from, to: input.to };
    }

    const terminal = opportunityStateMachine.isTerminal(input.to);
    const updated = await this.db
      .update(opportunities)
      .set({ state: input.to, closedAt: terminal ? input.at : null })
      .where(and(eq(opportunities.id, input.opportunityId), eq(opportunities.state, input.from)))
      .returning({ id: opportunities.id });

    if (updated.length > 0) return { kind: "OK", state: input.to };

    const [row] = await this.db
      .select({ state: opportunities.state })
      .from(opportunities)
      .where(eq(opportunities.id, input.opportunityId))
      .limit(1);
    return { kind: "CONFLICT", expected: input.from, actual: row?.state ?? null };
  }

  /**
   * Nutzerreaktion festhalten.
   *
   * Append-only und mit der TATSAECHLICHEN Reaktionszeit dieser einen
   * Gelegenheit (I-9). Es gibt hier bewusst keine Aggregatspalte.
   */
  async recordManualResponse(input: {
    readonly opportunityId: string;
    readonly kind: "SEEN" | "USER_CONFIRMED" | "REJECTED";
    readonly at: Date;
    readonly responseMs: number;
    readonly priceAtResponseUsd: number | null;
  }): Promise<void> {
    await this.db.insert(manualResponses).values({
      opportunityId: input.opportunityId,
      kind: input.kind,
      at: input.at,
      responseMs: input.responseMs,
      priceAtResponseUsd: input.priceAtResponseUsd,
    });
  }

  /**
   * Hypothetischen Verlauf fortschreiben.
   *
   * Keine Kapitalspalte — das ist die strukturelle Fassung von „MISSED ≠ LOSS"
   * und „USER_REJECTED ≠ LOSS". Ein Upsert, weil der Verlauf mit der Zeit
   * praeziser wird, nicht laenger.
   */
  async upsertOutcome(input: {
    readonly opportunityId: string;
    readonly referencePriceUsd: number;
    readonly return5m: number | null;
    readonly return15m: number | null;
    readonly return30m: number | null;
    readonly return1h: number | null;
    readonly return4h: number | null;
    readonly hypotheticalMfe: number | null;
    readonly hypotheticalMae: number | null;
    readonly observedUntil: Date;
  }): Promise<void> {
    await this.db
      .insert(opportunityOutcomes)
      .values({ ...input, updatedAt: input.observedUntil })
      .onConflictDoUpdate({
        target: opportunityOutcomes.opportunityId,
        set: {
          return5m: input.return5m,
          return15m: input.return15m,
          return30m: input.return30m,
          return1h: input.return1h,
          return4h: input.return4h,
          hypotheticalMfe: input.hypotheticalMfe,
          hypotheticalMae: input.hypotheticalMae,
          observedUntil: input.observedUntil,
          updatedAt: input.observedUntil,
        },
      });
  }

  /**
   * Abgelaufene Gelegenheiten schliessen.
   *
   * Zeitgesteuert und nicht beim naechsten Login (I-11). Nur aus OFFERED und
   * SEEN — eine bestaetigte Gelegenheit laeuft nicht ab, sie wird eroeffnet
   * oder entwertet.
   */
  async expireOverdue(now: Date): Promise<readonly string[]> {
    const expired = await this.db
      .update(opportunities)
      .set({ state: "EXPIRED", closedAt: now })
      .where(
        // ISO-Zeichenkette mit Cast statt eines gebundenen `Date`: postgres-js
        // bricht sonst mit "Received an instance of Date" ab, waehrend PGlite
        // es durchlaesst. Ohne den Cast liefen Gelegenheiten im Betrieb nie ab
        // — und ohne Ablauf gaebe es weder EXPIRED noch MISSED.
        sql`${opportunities.respondBy} is not null
            and ${opportunities.respondBy} < ${now.toISOString()}::timestamptz
            and ${opportunities.state} in ('OFFERED','SEEN')`,
      )
      .returning({ id: opportunities.id });
    return expired.map((r) => r.id);
  }

  async findById(opportunityId: string): Promise<typeof opportunities.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.id, opportunityId))
      .limit(1);
    return row ?? null;
  }
}

export type { SizingMode };
