import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { candidateStateMachine, type CandidateState, type ResearchBatch } from "@sae/research";

import type { Database } from "../client";
import { candidateTransitions, researchBatches, strategyCandidates } from "../schema/research";
import { paperPositions } from "../schema/opportunities";

/**
 * Schreibpfad fuer Forschung und Strategie-Kandidaten.
 *
 * Zwei Dinge sind hier append-only und in der Migration schreibgeschuetzt:
 * die eingefrorenen Zeitgrenzen und die Zustandswechsel. Beides sind Beweise.
 * Eine nachtraeglich verschobene Grenze waere nicht nur falsch, sondern
 * unbemerkbar; ein nachtraeglich gesetzter Zustandswechsel liesse eine
 * Strategie so aussehen, als haette sie die Pruefkette durchlaufen.
 */
export type AdvanceResult =
  | { readonly kind: "OK" }
  | { readonly kind: "ILLEGAL" }
  | { readonly kind: "CONFLICT"; readonly actual: CandidateState | null }
  /** Der Schritt waere erlaubt, aber es gibt keine belastbare Datengrundlage. */
  | { readonly kind: "NO_EVIDENCE"; readonly detail: string };

/**
 * Zustaende, die eine Datengrundlage voraussetzen.
 *
 * Alles ausser REJECTED und SHELVED: ein Kandidat darf jederzeit verworfen oder
 * zurueckgestellt werden, aber nicht ohne Evidenz vorankommen.
 */
const EVIDENCE_REQUIRING_STATES: ReadonlySet<CandidateState> = new Set<CandidateState>([
  "BACKTESTED",
  "WALK_FORWARDED",
  "OUT_OF_SAMPLE_TESTED",
  "SHADOW_TRADING",
  "PROMOTED",
]);

export class ResearchRepository {
  constructor(private readonly db: Database) {}

  /**
   * Zeitgrenzen einfrieren.
   *
   * `UNIQUE (boundary_hash)` setzt I-12 um: derselbe Datenbereich kann nicht
   * zweimal als eigener Batch gefuehrt werden und dieselbe Erkenntnis zweimal
   * bestaetigen. Ein zweiter Versuch bekommt den vorhandenen Batch.
   */
  async freezeBatch(
    batch: ResearchBatch,
    note: string | null = null,
  ): Promise<{ readonly kind: "CREATED" | "EXISTS"; readonly batchId: string }> {
    const [created] = await this.db
      .insert(researchBatches)
      .values({
        trainFrom: batch.trainFrom,
        trainTo: batch.trainTo,
        oosFrom: batch.oosFrom,
        oosTo: batch.oosTo,
        embargoSeconds: batch.embargoSeconds,
        frozenAt: batch.frozenAt,
        boundaryHash: batch.boundaryHash,
        note,
      })
      .onConflictDoNothing({ target: researchBatches.boundaryHash })
      .returning({ id: researchBatches.id });

    if (created !== undefined) return { kind: "CREATED", batchId: created.id };

    const [existing] = await this.db
      .select({ id: researchBatches.id })
      .from(researchBatches)
      .where(eq(researchBatches.boundaryHash, batch.boundaryHash))
      .limit(1);
    if (existing === undefined) throw new Error("Batch war doppelt und ist nicht auffindbar");
    return { kind: "EXISTS", batchId: existing.id };
  }

  async createCandidate(input: {
    readonly origin: "FEATURE_ANALYSIS" | "REJECTION_ANALYSIS" | "PARAMETER_VARIATION" | "MANUAL";
    readonly researchBatchId: string;
    readonly baseStrategyVersionId: string;
    readonly hypothesis: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly hypothesisAt: Date;
  }): Promise<string> {
    const [row] = await this.db
      .insert(strategyCandidates)
      .values({ ...input, parameters: input.parameters as never })
      .returning({ id: strategyCandidates.id });
    if (row === undefined) throw new Error("Kandidat konnte nicht angelegt werden");
    return row.id;
  }

  /**
   * Zustandswechsel eines Kandidaten.
   *
   * Erst der Automat (ist der Schritt erlaubt), dann die Datenbank (steht der
   * Kandidat noch dort, wo wir ihn vermuten). Der Uebergang wird zusaetzlich
   * in `candidate_transitions` protokolliert — ohne dieses Protokoll liesse
   * sich hinterher nicht sagen, ob die Kette wirklich durchlaufen wurde oder
   * ob jemand den Zustand gesetzt hat.
   */
  async advance(input: {
    readonly candidateId: string;
    readonly from: CandidateState;
    readonly to: CandidateState;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly reason: string | null;
    readonly at: Date;
  }): Promise<AdvanceResult> {
    if (!candidateStateMachine.canTransition(input.from, input.to)) {
      return { kind: "ILLEGAL" };
    }

    // Vorwaertsschritte in der Pruefkette brauchen echte Evidenz.
    //
    // Die Sperre steht hier und nicht beim Aufrufer, weil sie sonst genau der
    // Aufrufer waere, den jemand vergisst. REJECTED und SHELVED sind
    // ausgenommen: einen Kandidaten zu verwerfen darf nie an fehlender Evidenz
    // scheitern — das waere die falsche Richtung.
    if (EVIDENCE_REQUIRING_STATES.has(input.to)) {
      const evidence = await this.productionEvidence();
      if (evidence.closedPositions === 0) {
        return {
          kind: "NO_EVIDENCE" as const,
          detail:
            "Keine abgeschlossene Paper-Position mit echter Herkunft. Test-Fixtures zaehlen ausdruecklich nicht.",
        };
      }
    }

    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(strategyCandidates)
        .set({ state: input.to, closedReason: input.reason, updatedAt: input.at })
        .where(
          // `and(...)`, nicht `&&`: der logische Operator liefert schlicht den
          // zweiten Ausdruck zurueck, und das WHERE haette dann nur den Zustand
          // geprueft — der Zustandswechsel haette JEDEN Kandidaten in diesem
          // Zustand getroffen.
          and(eq(strategyCandidates.id, input.candidateId), eq(strategyCandidates.state, input.from)),
        )
        .returning({ id: strategyCandidates.id });

      if (updated[0] === undefined) {
        const [row] = await tx
          .select({ state: strategyCandidates.state })
          .from(strategyCandidates)
          .where(eq(strategyCandidates.id, input.candidateId))
          .limit(1);
        return { kind: "CONFLICT" as const, actual: row?.state ?? null };
      }

      await tx.insert(candidateTransitions).values({
        candidateId: input.candidateId,
        fromState: input.from,
        toState: input.to,
        evidence: input.evidence as never,
        reason: input.reason,
        at: input.at,
      });

      return { kind: "OK" as const };
    });
  }

  /**
   * Wie viel belastbare Evidenz es gibt.
   *
   * Zaehlt AUSSCHLIESSLICH abgeschlossene Positionen mit echter Herkunft. Ein
   * Test-Fixture erhoeht diese Zahl nicht — nicht weil ein Filter ihn
   * heraussortiert, sondern weil die Abfrage ihn nie einbezieht.
   *
   * Diese Zahl ist die Eintrittskarte in die Pruefkette. Ohne sie waere die
   * naheliegendste Art, das System zu taeuschen, ein Entwicklungslauf mit
   * Fixtures, der hinterher wie eine Messreihe aussieht.
   */
  async productionEvidence(): Promise<{
    readonly closedPositions: number;
    readonly byStream: Readonly<Record<string, number>>;
  }> {
    const rows = await this.db
      .select({ stream: paperPositions.stream, count: sql<number>`count(*)::int` })
      .from(paperPositions)
      .where(and(eq(paperPositions.isTestFixture, false), isNotNull(paperPositions.closedAt)))
      .groupBy(paperPositions.stream);

    const byStream: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byStream[row.stream] = row.count;
      total += row.count;
    }
    return { closedPositions: total, byStream };
  }

  async transitionsFor(candidateId: string): Promise<readonly (typeof candidateTransitions.$inferSelect)[]> {
    return this.db
      .select()
      .from(candidateTransitions)
      .where(eq(candidateTransitions.candidateId, candidateId))
      .orderBy(desc(candidateTransitions.at));
  }
}
