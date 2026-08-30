import { and, asc, desc, gt, isNull, lte, or, eq } from "drizzle-orm";
import type { Database } from "../client";
import { smartMoneyWallets, tokenSecurity, tokenSnapshots } from "../schema/index";
import type { PitReader, PitSecurity, PitSnapshot } from "./reader";

/**
 * Die einzige Implementierung.
 *
 * Live- und Backtest-Betrieb unterscheiden sich NICHT in der Abfrage — beide
 * filtern hart auf `observed_at <= asOf`. Der Unterschied liegt allein darin,
 * wer `asOf` liefert: im Livebetrieb die Uhr, im Backtest die Simulationszeit.
 *
 * Zwei getrennte Implementierungen waeren eine Einladung, im Backtest-Pfad
 * "kurz mal" den Filter wegzulassen. Hier gibt es nur einen Ort, an dem der
 * Filter steht, und einen Test, der ihn beweist.
 */
export class PostgresPitReader implements PitReader {
  readonly mode: "live" | "backtest";
  readonly #db: Database;

  constructor(db: Database, mode: "live" | "backtest") {
    this.#db = db;
    this.mode = mode;
  }

  async snapshotAt(tokenId: string, asOf: Date): Promise<PitSnapshot | null> {
    const rows = await this.#db
      .select()
      .from(tokenSnapshots)
      .where(and(eq(tokenSnapshots.tokenId, tokenId), lte(tokenSnapshots.observedAt, asOf)))
      .orderBy(desc(tokenSnapshots.observedAt))
      .limit(1);

    const row = rows[0];
    return row ? mapSnapshot(row) : null;
  }

  async snapshotsBetween(tokenId: string, from: Date, asOf: Date): Promise<PitSnapshot[]> {
    const rows = await this.#db
      .select()
      .from(tokenSnapshots)
      .where(
        and(
          eq(tokenSnapshots.tokenId, tokenId),
          gt(tokenSnapshots.observedAt, from),
          lte(tokenSnapshots.observedAt, asOf),
        ),
      )
      .orderBy(asc(tokenSnapshots.observedAt));

    return rows.map(mapSnapshot);
  }

  async securityAt(tokenId: string, asOf: Date): Promise<PitSecurity | null> {
    const rows = await this.#db
      .select()
      .from(tokenSecurity)
      .where(and(eq(tokenSecurity.tokenId, tokenId), lte(tokenSecurity.observedAt, asOf)))
      .orderBy(desc(tokenSecurity.observedAt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    return {
      tokenId: row.tokenId,
      observedAt: row.observedAt,
      mintAuthorityActive: row.mintAuthorityActive,
      freezeAuthorityActive: row.freezeAuthorityActive,
      lpBurnedOrLocked: row.lpBurnedOrLocked,
      top10HolderSharePct: row.top10HolderSharePct,
      riskLevel: row.riskLevel,
      securityScore: row.securityScore,
    };
  }

  async smartMoneyQualifiedAt(asOf: Date): Promise<string[]> {
    const rows = await this.#db
      .select({ address: smartMoneyWallets.address })
      .from(smartMoneyWallets)
      .where(
        and(
          // Qualifikation muss VOR dem Entscheidungszeitpunkt bestanden haben.
          lte(smartMoneyWallets.qualifiedAt, asOf),
          // Eine spaetere Disqualifikation darf die Vergangenheit nicht entwerten.
          or(
            isNull(smartMoneyWallets.disqualifiedAt),
            gt(smartMoneyWallets.disqualifiedAt, asOf),
          ),
        ),
      );

    return [...new Set(rows.map((r) => r.address))];
  }
}

type SnapshotRow = typeof tokenSnapshots.$inferSelect;

function mapSnapshot(row: SnapshotRow): PitSnapshot {
  return {
    tokenId: row.tokenId,
    observedAt: row.observedAt,
    priceUsd: row.priceUsd,
    marketCapUsd: row.marketCapUsd,
    liquidityUsd: row.liquidityUsd,
    volume24hUsd: row.volume24hUsd,
    holders: row.holders,
    finalScore: row.finalScore,
    dataCompleteness: row.dataCompleteness,
    scoreEngineVersion: row.scoreEngineVersion,
  };
}
