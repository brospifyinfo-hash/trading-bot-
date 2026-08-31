/**
 * Wie sehr haengt ein Ergebnis an Zufall?
 *
 * §117 bis §120 und §126 fragen nach drei Dingen, die dieselbe Ursache haben:
 * ein Backtest-Ergebnis kann gut aussehen, weil die Strategie funktioniert —
 * oder weil ein paar glueckliche Trades und ein paar zufaellig gut gewaehlte
 * Parameter zusammengekommen sind.
 *
 * I-7 nennt den konkreten Fall: neun Take-Profit-Varianten gegen fuenf
 * Stop-Varianten sind 45 Kombinationen. Die beste davon sieht immer gut aus.
 * Das ist keine Erkenntnis, sondern eine Eigenschaft des Suchens.
 *
 * Der wichtigste Begriff dieses Moduls ist die Unterscheidung zwischen
 * **Plateau und Gipfel**:
 *
 *   Plateau  Das Ergebnis bleibt stabil, wenn man den Parameter verschiebt.
 *            Der Wert war eine Entscheidung, aber keine kritische.
 *   Gipfel   Das Ergebnis faellt in JEDE Richtung stark ab. Der Wert sitzt
 *            genau auf der Spitze — und Spitzen entstehen in verrauschten
 *            Oberflaechen von selbst. Das ist die Signatur von Overfitting.
 *   Hang     Das Ergebnis wird in eine Richtung besser. Dann wurde die Grenze
 *            nicht gefunden, sondern gesetzt — die Suche ist nicht fertig.
 *
 * Ein Gipfel ist nicht „ein besonders guter Parameter". Er ist der Grund, einen
 * Kandidaten abzulehnen.
 */

/* ---------------------------------------------------------------- §126 */

export interface OutlierContribution {
  readonly tradeCount: number;
  readonly totalReturn: number;
  /** Ergebnis ohne den besten Trade. */
  readonly withoutBest: number;
  /** Ergebnis ohne die besten fuenf. */
  readonly withoutTopFive: number;
  /** Anteil des besten Trades am Gesamtergebnis. */
  readonly bestShare: number | null;
  readonly topFiveShare: number | null;
  /**
   * Ob das Ergebnis ohne den besten Trade das Vorzeichen wechselt.
   *
   * Der entscheidende Befund: eine Strategie, die ohne ihren besten Trade
   * Verlust macht, hat keinen Vorteil gemessen, sondern einen Gluecksfall.
   */
  readonly signFlipsWithoutBest: boolean;
  readonly signFlipsWithoutTopFive: boolean;
  readonly verdict: "ROBUST" | "CARRIED_BY_OUTLIERS" | "TOO_LITTLE_DATA";
  readonly note: string;
}

export const MIN_TRADES_FOR_OUTLIER_VERDICT = 30;

export function analyzeOutlierContribution(
  netReturns: readonly number[],
): OutlierContribution {
  const n = netReturns.length;
  const total = netReturns.reduce((a, b) => a + b, 0);

  if (n < MIN_TRADES_FOR_OUTLIER_VERDICT) {
    return {
      tradeCount: n,
      totalReturn: total,
      withoutBest: total,
      withoutTopFive: total,
      bestShare: null,
      topFiveShare: null,
      signFlipsWithoutBest: false,
      signFlipsWithoutTopFive: false,
      verdict: "TOO_LITTLE_DATA",
      note: `${n} Trades — unter ${MIN_TRADES_FOR_OUTLIER_VERDICT} sagt die Konzentration nichts.`,
    };
  }

  const sorted = [...netReturns].sort((a, b) => b - a);
  const best = sorted[0]!;
  const topFive = sorted.slice(0, 5).reduce((a, b) => a + b, 0);
  const withoutBest = total - best;
  const withoutTopFive = total - topFive;

  const flips = (a: number, b: number): boolean => a > 0 && b <= 0;
  const signFlipsWithoutBest = flips(total, withoutBest);
  const signFlipsWithoutTopFive = flips(total, withoutTopFive);

  const carried = signFlipsWithoutBest || signFlipsWithoutTopFive;

  return {
    tradeCount: n,
    totalReturn: total,
    withoutBest,
    withoutTopFive,
    // Anteil nur bei positivem Gesamtergebnis sinnvoll: bei einem Verlust ist
    // „Anteil am Ergebnis" keine verstaendliche Groesse.
    bestShare: total > 0 ? best / total : null,
    topFiveShare: total > 0 ? topFive / total : null,
    signFlipsWithoutBest,
    signFlipsWithoutTopFive,
    verdict: carried ? "CARRIED_BY_OUTLIERS" : "ROBUST",
    note: signFlipsWithoutBest
      ? "Ohne den besten Trade Verlust — das ist ein Gluecksfall, kein Vorteil."
      : signFlipsWithoutTopFive
        ? "Ohne die besten fuenf Trades Verlust."
        : "Ergebnis bleibt auch ohne die groessten Gewinner positiv.",
  };
}

/* ------------------------------------------------------------ §117–§120 */

/** Die vorgeschriebenen Auslenkungen aus I-7. */
export const STANDARD_PERTURBATIONS: readonly number[] = [-0.2, -0.1, -0.05, 0.05, 0.1, 0.2];

export type ParameterShape = "PLATEAU" | "PEAK" | "SLOPE" | "NOT_EVALUABLE";

export interface ParameterSensitivity {
  readonly parameter: string;
  readonly baseValue: number;
  readonly baseResult: number;
  /** Ergebnis je Auslenkung, in derselben Reihenfolge wie die Eingabe. */
  readonly points: readonly { readonly delta: number; readonly value: number; readonly result: number }[];
  /** Groesster relativer Abfall gegenueber dem Basiswert. */
  readonly worstRelativeDrop: number | null;
  /** Groesste relative Verbesserung. Ein Hinweis, dass die Suche nicht fertig ist. */
  readonly bestRelativeGain: number | null;
  readonly shape: ParameterShape;
  readonly note: string;
}

export interface SensitivitySettings {
  readonly perturbations: readonly number[];
  /**
   * Ab welchem relativen Abfall in BEIDE Richtungen ein Gipfel vorliegt.
   *
   * Berichtskonvention, keine Messung: ein Drittel des Ergebnisses bei 5 %
   * Parameteraenderung zu verlieren, ist der Punkt, ab dem ich dem Wert nicht
   * mehr traue. Sobald genug Kandidaten durchgelaufen sind, um die Verteilung
   * der Abfaelle zu kennen, gehoert der Wert ersetzt.
   */
  readonly peakDropThreshold: number;
  /** Ab welcher Verbesserung die Suche als nicht abgeschlossen gilt. */
  readonly slopeGainThreshold: number;
}

export const DEFAULT_SENSITIVITY_SETTINGS: SensitivitySettings = {
  perturbations: STANDARD_PERTURBATIONS,
  peakDropThreshold: 0.33,
  slopeGainThreshold: 0.15,
};

/**
 * Verschiebt einen Parameter und misst, was mit dem Ergebnis passiert.
 *
 * `evaluate` muss deterministisch sein: dieselben Parameter, dasselbe Ergebnis.
 * Andernfalls misst diese Funktion die Streuung des Backtests statt die
 * Empfindlichkeit des Parameters — und beides sieht gleich aus.
 */
export function analyzeParameterSensitivity(input: {
  readonly parameter: string;
  readonly baseValue: number;
  readonly evaluate: (value: number) => number | null;
  readonly settings?: Partial<SensitivitySettings>;
}): ParameterSensitivity {
  const settings = { ...DEFAULT_SENSITIVITY_SETTINGS, ...input.settings };
  const baseResult = input.evaluate(input.baseValue);

  if (baseResult === null || baseResult === 0) {
    return {
      parameter: input.parameter,
      baseValue: input.baseValue,
      baseResult: baseResult ?? 0,
      points: [],
      worstRelativeDrop: null,
      bestRelativeGain: null,
      shape: "NOT_EVALUABLE",
      // Ohne verwertbares Basisergebnis ist jede relative Aenderung undefiniert.
      // Insbesondere ist ein Basisergebnis von null kein „neutraler" Fall.
      note: "Kein verwertbares Basisergebnis — Empfindlichkeit nicht bestimmbar.",
    };
  }

  const points: { delta: number; value: number; result: number }[] = [];
  for (const delta of settings.perturbations) {
    const value = input.baseValue * (1 + delta);
    const result = input.evaluate(value);
    if (result !== null) points.push({ delta, value, result });
  }

  if (points.length < 2) {
    return {
      parameter: input.parameter,
      baseValue: input.baseValue,
      baseResult,
      points,
      worstRelativeDrop: null,
      bestRelativeGain: null,
      shape: "NOT_EVALUABLE",
      note: "Zu wenige auswertbare Auslenkungen.",
    };
  }

  const relative = (r: number): number => (r - baseResult) / Math.abs(baseResult);
  const changes = points.map((p) => relative(p.result));
  const worstRelativeDrop = -Math.min(...changes);
  const bestRelativeGain = Math.max(...changes);

  const negatives = points.filter((p) => p.delta < 0).map((p) => relative(p.result));
  const positives = points.filter((p) => p.delta > 0).map((p) => relative(p.result));
  const dropsBothWays =
    negatives.length > 0 &&
    positives.length > 0 &&
    Math.min(...negatives) < -settings.peakDropThreshold &&
    Math.min(...positives) < -settings.peakDropThreshold;

  let shape: ParameterShape;
  let note: string;
  if (bestRelativeGain > settings.slopeGainThreshold) {
    shape = "SLOPE";
    note =
      `Ergebnis wird bei Auslenkung um ${(bestRelativeGain * 100).toFixed(0)} % besser — ` +
      "die Grenze wurde gesetzt, nicht gefunden.";
  } else if (dropsBothWays) {
    shape = "PEAK";
    note =
      `Faellt in beide Richtungen um mehr als ${(settings.peakDropThreshold * 100).toFixed(0)} % — ` +
      "der Wert sitzt auf einer Spitze, und Spitzen entstehen in verrauschten Oberflaechen von selbst.";
  } else {
    shape = "PLATEAU";
    note = `Stabil: groesster Abfall ${(worstRelativeDrop * 100).toFixed(0)} %.`;
  }

  return {
    parameter: input.parameter,
    baseValue: input.baseValue,
    baseResult,
    points,
    worstRelativeDrop,
    bestRelativeGain,
    shape,
    note,
  };
}

/* ---------------------------------------------------------------- Gesamt */

export interface FragilityAssessment {
  /** 0..100, hoch heisst zerbrechlich. */
  readonly score: number;
  readonly outliers: OutlierContribution;
  readonly parameters: readonly ParameterSensitivity[];
  readonly reasons: readonly string[];
  /**
   * Ob dieser Kandidat an der Fragilitaet scheitert.
   *
   * Bewusst ein Gate und kein Punktwert, der sich mit anderen verrechnen laesst:
   * ein Ergebnis, das an einem Trade oder an einem Parameterwert haengt, wird
   * nicht dadurch tragfaehig, dass die uebrigen Kennzahlen gut aussehen.
   */
  readonly blocked: boolean;
}

export function assessFragility(input: {
  readonly netReturns: readonly number[];
  readonly parameters: readonly ParameterSensitivity[];
}): FragilityAssessment {
  const outliers = analyzeOutlierContribution(input.netReturns);
  const reasons: string[] = [];
  let score = 0;

  if (outliers.verdict === "TOO_LITTLE_DATA") {
    score += 40;
    reasons.push(`Nur ${outliers.tradeCount} Trades — Konzentration nicht beurteilbar.`);
  } else if (outliers.signFlipsWithoutBest) {
    score += 60;
    reasons.push("Ohne den besten Trade negativ.");
  } else if (outliers.signFlipsWithoutTopFive) {
    score += 35;
    reasons.push("Ohne die besten fuenf Trades negativ.");
  } else if ((outliers.bestShare ?? 0) > 0.5) {
    score += 20;
    reasons.push(
      `Ein Trade macht ${((outliers.bestShare ?? 0) * 100).toFixed(0)} % des Ergebnisses aus.`,
    );
  }

  const peaks = input.parameters.filter((p) => p.shape === "PEAK");
  const slopes = input.parameters.filter((p) => p.shape === "SLOPE");
  const unevaluable = input.parameters.filter((p) => p.shape === "NOT_EVALUABLE");

  score += Math.min(40, peaks.length * 20);
  score += Math.min(20, slopes.length * 10);
  score += Math.min(20, unevaluable.length * 10);

  for (const p of peaks) reasons.push(`${p.parameter} sitzt auf einer Spitze.`);
  for (const p of slopes) reasons.push(`${p.parameter}: Suche nicht abgeschlossen.`);
  for (const p of unevaluable) reasons.push(`${p.parameter} nicht auswertbar.`);

  return {
    score: Math.min(100, score),
    outliers,
    parameters: input.parameters,
    reasons,
    // Jeder einzelne dieser Befunde reicht. Sie werden nicht gegeneinander
    // aufgerechnet.
    blocked:
      outliers.verdict !== "ROBUST" || peaks.length > 0 || unevaluable.length > 0,
  };
}
