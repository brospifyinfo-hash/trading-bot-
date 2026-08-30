import type { EvEstimate } from "@sae/core";

/**
 * Erwartungswertschaetzung.
 *
 * Der Teil, den die meisten Systeme auslassen: ein Score ist eine Sortierung,
 * keine Handelsentscheidung. Die Frage ist nicht "wie gut sieht der Token aus",
 * sondern "was hat historisch herausgekommen, wenn er so aussah".
 *
 *     EV = p(win) · E[R | win] − (1 − p(win)) · E[|R| | loss] − Kosten
 *
 * `p(win)` und die Renditen sind EMPIRISCHE Groessen aus der eigenen realisierten
 * Verteilung. Ohne belastbare Stichprobe sind sie unbekannt — und unbekannt ist
 * ein eigener Fall, nicht "nimm 50 %".
 */

export interface OutcomeSample {
  /** Nettorendite eines abgeschlossenen Trades, z. B. 0.35 fuer +35 %. */
  readonly netReturn: number;
}

export interface EvInputs {
  /** Abgeschlossene Trades im passenden Bucket (Score, Liquiditaet, Alter …). */
  readonly sample: readonly OutcomeSample[];
  /** Erwartete Ausfuehrungskosten dieses Trades als Anteil, z. B. 0.02 fuer 2 %. */
  readonly expectedCostFraction: number;
  readonly minSampleSize: number;
}

export interface EvDetail {
  readonly estimate: EvEstimate;
  /** Punktschaetzung — was die Stichprobe im Mittel ergeben hat. */
  readonly pointEv: number | null;
  /**
   * Untere Grenze des 95-%-Wilson-Intervalls auf die Trefferquote, eingesetzt
   * in dieselbe Formel. DIESE Zahl entscheidet, nicht die Punktschaetzung:
   * bei 12 Trades und 75 % Trefferquote ist die Punktschaetzung schmeichelhaft
   * und die Untergrenze ehrlich.
   */
  readonly conservativeEv: number | null;
  readonly winRate: number | null;
  readonly winRateLowerBound: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
}

/**
 * Wilson-Score-Intervall, untere Grenze.
 *
 * Gegenueber dem naiven Anteil hat es zwei Eigenschaften, auf die es hier
 * ankommt: es bleibt bei kleinen Stichproben sinnvoll, und es liefert bei
 * 3 von 3 Treffern nicht 100 %.
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return Math.max(0, (centre - margin) / denominator);
}

export function estimateEv(input: EvInputs): EvDetail {
  const n = input.sample.length;

  if (n < input.minSampleSize) {
    return {
      estimate: { kind: "UNKNOWN", reason: "INSUFFICIENT_SAMPLE", sampleSize: n },
      pointEv: null,
      conservativeEv: null,
      winRate: null,
      winRateLowerBound: null,
      avgWin: null,
      avgLoss: null,
    };
  }

  const wins = input.sample.filter((s) => s.netReturn > 0);
  const losses = input.sample.filter((s) => s.netReturn <= 0);

  const winRate = wins.length / n;
  const winRateLowerBound = wilsonLowerBound(wins.length, n);

  const avgWin = wins.length > 0 ? wins.reduce((a, s) => a + s.netReturn, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0 ? Math.abs(losses.reduce((a, s) => a + s.netReturn, 0) / losses.length) : 0;

  const ev = (p: number): number => p * avgWin - (1 - p) * avgLoss - input.expectedCostFraction;

  const pointEv = ev(winRate);
  const conservativeEv = ev(winRateLowerBound);

  // Konfidenz aus der Breite des Intervalls: eine enge Schaetzung ist
  // vertrauenswuerdiger als eine breite, unabhaengig davon, wie guenstig sie ist.
  const confidence = Math.max(0, Math.min(1, 1 - (winRate - winRateLowerBound) * 2));

  return {
    estimate: {
      kind: "ESTIMATED",
      evPerUnit: conservativeEv,
      confidence,
      sampleSize: n,
    },
    pointEv,
    conservativeEv,
    winRate,
    winRateLowerBound,
    avgWin,
    avgLoss,
  };
}
