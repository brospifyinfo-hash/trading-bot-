import type { Currency } from "@sae/core";
import {
  computeTradeStatistics,
  MIN_SAMPLE_FOR_VERDICT,
  type ClosedTrade,
  type TradeStatistics,
} from "./trade-statistics";

/**
 * Faktorforschung.
 *
 * Beantwortet die einzige Frage, die zaehlt: welche Faktoren erzeugen
 * tatsaechlich Erwartungswert? Nicht "welcher Score korreliert mit Gewinn" —
 * das laesst sich auf jeder Stichprobe finden, wenn man lange genug sucht.
 *
 * Deshalb drei Vorkehrungen:
 *
 * 1. Jeder Bucket traegt seine Stichprobengroesse und ein Konfidenzintervall.
 *    Eine Zahl ohne Intervall laedt dazu ein, sie fuer belastbar zu halten.
 * 2. Ein Bucket unter der Mindestgroesse bekommt KEIN Urteil, sondern den
 *    Vermerk "zu wenig Daten". Auch dann nicht, wenn er gut aussieht.
 * 3. Der Vergleich braucht BEIDE Seiten. Ein Faktor, der nur in einer Auspraegung
 *    beobachtet wurde, sagt nichts ueber seine Wirkung.
 */

export interface FactorBucket {
  readonly label: string;
  readonly trades: readonly ClosedTrade[];
}

export interface BucketResult {
  readonly label: string;
  readonly statistics: TradeStatistics;
  /** 95-%-Intervall auf die Trefferquote. */
  readonly winRateInterval: { readonly lower: number; readonly upper: number } | null;
  readonly verdict: "TOO_LITTLE_DATA" | "MEASURED";
}

export interface FactorComparison {
  readonly factor: string;
  readonly buckets: readonly BucketResult[];
  /**
   * Nur gesetzt, wenn ALLE Buckets genug Daten haben UND sich die Intervalle
   * der Trefferquoten nicht ueberlappen. Andernfalls null — ein Unterschied,
   * dessen Intervalle sich ueberschneiden, ist kein beobachteter Unterschied.
   */
  readonly separation: {
    readonly better: string;
    readonly worse: string;
    readonly winRateGap: number;
  } | null;
  readonly note: string;
}

/** Wilson-Score-Intervall, beide Grenzen. */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return {
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  };
}

export function compareFactor(
  factor: string,
  buckets: readonly FactorBucket[],
  currency: Currency,
): FactorComparison {
  const results: BucketResult[] = buckets.map((bucket) => {
    const statistics = computeTradeStatistics(bucket.trades, currency);
    const enough = statistics.totalTrades >= MIN_SAMPLE_FOR_VERDICT;
    return {
      label: bucket.label,
      statistics,
      winRateInterval:
        statistics.totalTrades > 0
          ? wilsonInterval(statistics.winningTrades, statistics.totalTrades)
          : null,
      verdict: enough ? "MEASURED" : "TOO_LITTLE_DATA",
    };
  });

  const underpowered = results.filter((r) => r.verdict === "TOO_LITTLE_DATA");
  if (underpowered.length > 0) {
    return {
      factor,
      buckets: results,
      separation: null,
      note: `Kein Urteil: ${underpowered
        .map((r) => `${r.label} (${r.statistics.totalTrades} Trades)`)
        .join(", ")} unter ${MIN_SAMPLE_FOR_VERDICT} Trades.`,
    };
  }

  if (results.length < 2) {
    return {
      factor,
      buckets: results,
      separation: null,
      note: "Kein Vergleich moeglich: ein Faktor braucht mindestens zwei Auspraegungen.",
    };
  }

  const sorted = [...results].sort(
    (a, b) => (b.statistics.winRate ?? 0) - (a.statistics.winRate ?? 0),
  );
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;

  const overlap =
    best.winRateInterval !== null &&
    worst.winRateInterval !== null &&
    best.winRateInterval.lower <= worst.winRateInterval.upper;

  if (overlap) {
    return {
      factor,
      buckets: results,
      separation: null,
      note: "Kein beobachteter Unterschied: die Konfidenzintervalle ueberlappen sich.",
    };
  }

  return {
    factor,
    buckets: results,
    separation: {
      better: best.label,
      worse: worst.label,
      winRateGap: (best.statistics.winRate ?? 0) - (worst.statistics.winRate ?? 0),
    },
    note: "Unterschied beobachtet — kein Kausalitaetsnachweis und keine Zusage fuer die Zukunft.",
  };
}

/** Teilt Trades anhand eines Schwellwerts in zwei Auspraegungen. */
export function splitByThreshold<T extends ClosedTrade>(
  trades: readonly T[],
  valueOf: (trade: T) => number | null,
  threshold: number,
  labels: { readonly above: string; readonly below: string },
): FactorBucket[] {
  const above: T[] = [];
  const below: T[] = [];
  for (const trade of trades) {
    const value = valueOf(trade);
    // Trades ohne Merkmalswert gehoeren in KEINEN Bucket. Sie einer Seite
    // zuzuschlagen waere genau die stille Verzerrung, die eine Faktoranalyse
    // wertlos macht.
    if (value === null) continue;
    (value >= threshold ? above : below).push(trade);
  }
  return [
    { label: labels.above, trades: above },
    { label: labels.below, trades: below },
  ];
}
