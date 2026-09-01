import { eq } from "drizzle-orm";
import type { Clock, TokenId } from "@sae/core";
import {
  decideIngest,
  type IngestDecision,
  type IngestSettings,
  type MarketObservation,
  type SnapshotCandidate,
} from "@sae/pipeline";
import type { Sourced } from "@sae/providers";

import type { Database } from "../client";
import { tokenSnapshots } from "../schema/tokens";
import { PostgresSeenKeys } from "../stores/seen-keys";

/**
 * Schreibpfad fuer Marktdaten-Snapshots.
 *
 * Die Aufnahme muss unter mehreren Workern genau eine Zeile je Datenpunkt
 * erzeugen. Das laeuft hier in zwei Stufen, und die Reihenfolge ist der Punkt:
 *
 * 1. **Vorpruefung** ueber `PostgresSeenKeys`. Sie spart eine vergebliche
 *    Einfuegung — mehr nicht. Sie ist ausdruecklich KEINE Absicherung: zwischen
 *    ihrem SELECT und dem folgenden INSERT kann ein anderer Worker schreiben.
 * 2. **Entscheidung in der Datenbank** ueber `UNIQUE (ingest_key)` und
 *    `ON CONFLICT DO NOTHING`. Hier faellt die Nebenlaeufigkeit, und nur hier.
 *
 * Wer nur Stufe 1 baut, hat eine Race Condition, die im Test nie auftritt und
 * im Betrieb bei jedem zweiten Neustart. Wer nur Stufe 2 baut, hat es richtig —
 * aber mit mehr vergeblichen Einfuegungen. Beides zusammen ist korrekt und
 * sparsam.
 */

export type IngestResult =
  | { readonly kind: "ACCEPTED"; readonly snapshotId: string; readonly ingestKey: string }
  /** Denselben Datenpunkt gab es schon — zweiter Worker oder zweiter Lauf. */
  | { readonly kind: "DUPLICATE"; readonly ingestKey: string }
  /** Abgelehnt, bevor irgendetwas geschrieben wurde. */
  | { readonly kind: "REJECTED"; readonly decision: IngestDecision };

export class SnapshotRepository {
  readonly #seen: PostgresSeenKeys;

  constructor(private readonly db: Database) {
    this.#seen = new PostgresSeenKeys(db);
  }

  /** Der Vorpruefer, damit Aufrufer ihn nicht selbst bauen. */
  get seenKeys(): PostgresSeenKeys {
    return this.#seen;
  }

  /**
   * Nimmt eine Beobachtung auf — oder lehnt sie ab.
   *
   * Die Ablehnungsgruende stammen aus `decideIngest` und sind bewusst
   * verschieden: Zukunftsdaten, veraltete Daten, unbrauchbarer Preis und
   * fehlende Quelle sind vier verschiedene Probleme mit vier verschiedenen
   * Ursachen. Ein gemeinsames „ungueltig" wuerde sie im Log verwischen.
   */
  async ingest(input: {
    readonly tokenId: TokenId;
    readonly sourcedValue: Sourced<MarketObservation> | null;
    readonly clock: Clock;
    readonly noSourceReason?: string;
    readonly settings?: Partial<IngestSettings>;
  }): Promise<IngestResult> {
    const decision = await decideIngest({
      tokenId: input.tokenId,
      sourcedValue: input.sourcedValue,
      seen: this.#seen,
      clock: input.clock,
      ...(input.noSourceReason !== undefined ? { noSourceReason: input.noSourceReason } : {}),
      ...(input.settings !== undefined ? { settings: input.settings } : {}),
    });

    if (decision.kind === "DUPLICATE") {
      return { kind: "DUPLICATE", ingestKey: decision.ingestKey };
    }
    if (decision.kind !== "ACCEPT") {
      return { kind: "REJECTED", decision };
    }

    return this.write(decision.candidate);
  }

  /**
   * Schreibt einen geprueften Kandidaten.
   *
   * `ON CONFLICT DO NOTHING` auf dem Ingest-Schluessel: gewinnt ein anderer
   * Worker das Rennen, kommt hier keine Zeile zurueck — und das ist ein
   * regulaeres Ergebnis, kein Fehler.
   */
  async write(candidate: SnapshotCandidate): Promise<IngestResult> {
    const inserted = await this.db
      .insert(tokenSnapshots)
      .values({
        tokenId: String(candidate.tokenId),
        observedAt: candidate.observedAt,
        priceUsd: candidate.market.priceUsd,
        liquidityUsd: candidate.market.liquidityUsd,
        marketCapUsd: candidate.market.marketCapUsd,
        volume24hUsd: candidate.market.volume24hUsd,
        holders: candidate.market.holders,
        // Ohne berechnete Scores bleibt data_completeness die einzige ehrliche
        // Qualitaetsangabe: sie zaehlt, was tatsaechlich da war.
        dataCompleteness: completenessOf(candidate.market),
        missingInputs: missingOf(candidate.market),
        sourceProviderId: String(candidate.provenance.providerId),
        sourceTier: candidate.provenance.tier,
        sourceFreshnessSeconds: candidate.provenance.freshnessSeconds,
        sourceContributors: candidate.provenance.contributors.map((c) => ({
          providerId: String(c.providerId),
          tier: c.tier,
        })),
        ingestKey: candidate.ingestKey,
      })
      .onConflictDoNothing({ target: tokenSnapshots.ingestKey })
      .returning({ id: tokenSnapshots.id });

    const row = inserted[0];
    if (row === undefined) {
      return { kind: "DUPLICATE", ingestKey: candidate.ingestKey };
    }
    return { kind: "ACCEPTED", snapshotId: row.id, ingestKey: candidate.ingestKey };
  }

  async countForToken(tokenId: string): Promise<number> {
    const rows = await this.db
      .select({ id: tokenSnapshots.id })
      .from(tokenSnapshots)
      .where(eq(tokenSnapshots.tokenId, tokenId));
    return rows.length;
  }
}

/** Anteil vorhandener Marktfelder. Kein Ersatzwert fuer die fehlenden. */
function completenessOf(market: MarketObservation): number {
  const fields = [
    market.priceUsd,
    market.liquidityUsd,
    market.marketCapUsd,
    market.volume24hUsd,
    market.holders,
  ];
  const present = fields.filter((f) => f !== null && Number.isFinite(f)).length;
  return present / fields.length;
}

function missingOf(market: MarketObservation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    liquidityUsd: market.liquidityUsd,
    marketCapUsd: market.marketCapUsd,
    volume24hUsd: market.volume24hUsd,
    holders: market.holders,
  })) {
    if (value === null) out[name] = "NOT_PROVIDED_BY_SOURCE";
  }
  return out;
}
