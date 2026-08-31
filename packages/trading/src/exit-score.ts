import { score, type Score } from "@sae/core";

import type { ExitSignal, PositionMarketState } from "./exit-rules";

/**
 * Wie viel spricht dafuer, diese Position noch zu halten?
 *
 * §33 verlangt eine eigene Bewertungsebene fuer offene Positionen. Der Grund
 * ist keine Vollstaendigkeit, sondern ein Denkfehler, den fast jedes System
 * macht: den Einstiegsscore als Haltegrund weiterzuverwenden.
 *
 * Ein Token, der beim Einstieg 82 Punkte hatte, ist zwei Stunden spaeter nicht
 * „immer noch eine 82". Der Einstiegsscore beantwortet „wuerde ich das jetzt
 * kaufen?" — beim Halten ist die Frage aber eine andere: das Kapital ist schon
 * drin, ein Ausstieg kostet erneut Gebuehren, und ein Teil des Verlaufs ist
 * inzwischen bekannt. Zwei verschiedene Fragen brauchen zwei Zahlen.
 *
 * Der Exit Score ersetzt die harten Regeln NICHT. Er sagt nichts ueber den
 * Stop, ueber einen Sicherheitsbefund oder ueber einen verkaufenden Entwickler —
 * die greifen unabhaengig davon, wie diese Zahl ausfaellt. Er ist fuer die
 * Grauzone dazwischen: die Faelle, in denen keine Regel feuert und trotzdem
 * etwas nachlaesst.
 */

export type ExitScoreDimension =
  | "MOMENTUM_DECAY"
  | "GIVEBACK"
  | "LIQUIDITY_DRAIN"
  | "SELL_PRESSURE"
  | "AGE";

export interface ExitScoreResult {
  /** 0..100. Hoch heisst: viel spricht fuer einen Ausstieg. */
  readonly score: Score;
  readonly assessed: readonly ExitScoreDimension[];
  /** Dimensionen ohne Daten. Gehen NICHT als „unauffaellig" ein. */
  readonly unassessed: readonly ExitScoreDimension[];
  readonly perDimension: Readonly<Partial<Record<ExitScoreDimension, number>>>;
  /**
   * Ob ueberhaupt genug beurteilbar war. Bei `false` ist `score` nicht
   * belastbar und darf keine Entscheidung tragen — das ist ein anderer Fall
   * als „niedriger Score".
   */
  readonly computable: boolean;
  readonly drivers: readonly string[];
}

export interface ExitScoreThresholds {
  /** Ab welchem Rueckgang vom Hoch die Giveback-Dimension voll ausschlaegt. */
  readonly givebackAtHundredBps: number;
  /** Unter welcher Volumenbeschleunigung Momentum als tot gilt. */
  readonly deadVolumeAcceleration: number;
  /** Unter welchem Liquiditaetsverhaeltnis der Abzug voll ausschlaegt. */
  readonly liquidityFloorRatio: number;
  /** Unter welchem Kaeuferanteil der Verkaufsdruck voll ausschlaegt. */
  readonly sellPressureFloorBuyRatio: number;
  /** Wie viele Dimensionen mindestens beurteilbar sein muessen. */
  readonly minAssessedDimensions: number;
}

/**
 * Startwerte, ausdruecklich als Annahmen. Keiner ist an realen Ausstiegen
 * kalibriert; sobald Paper-Positionen mit Verlaeufen vorliegen, gehoeren sie
 * gegen die tatsaechliche Exit Efficiency geprueft.
 */
export const DEFAULT_EXIT_SCORE_THRESHOLDS: ExitScoreThresholds = {
  givebackAtHundredBps: 4_000,
  deadVolumeAcceleration: 0.5,
  liquidityFloorRatio: 0.4,
  sellPressureFloorBuyRatio: 0.3,
  minAssessedDimensions: 2,
};

/** Linear auf 0..100, an den Raendern begrenzt. */
function ramp(value: number, atZero: number, atHundred: number): number {
  if (atZero === atHundred) return 0;
  const t = (value - atZero) / (atHundred - atZero);
  return Math.max(0, Math.min(100, t * 100));
}

/**
 * Ausstiegsgruende sind ODER-verknuepft, nicht UND-verknuepft.
 *
 * Der Mittelwert waere hier der falsche Aggregator, und zwar auf eine Art, die
 * den ganzen Score entwertet: zwei voll ausgeschlagene Dimensionen von fuenf
 * ergeben 40 Punkte — unter jeder Handlungsschwelle. Der Score wuerde also erst
 * ausschlagen, wenn ALLES schlecht ist, und dann hat langst eine der harten
 * Regeln gefeuert. Genau die Grauzone, fuer die er gedacht ist, saehe er nie.
 *
 * Stattdessen die Gegenwahrscheinlichkeit: 1 − Π(1 − dᵢ). Ein einzelner
 * entscheidender Befund traegt allein, mehrere schwache verstaerken sich
 * (zweimal 50 ergibt 75), und nichts davon braucht eine Gewichtung, die man
 * spaeter passend machen koennte.
 */
function combineEvidence(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const survives = values.reduce((acc, v) => acc * (1 - Math.max(0, Math.min(100, v)) / 100), 1);
  return (1 - survives) * 100;
}

export function computeExitScore(
  market: PositionMarketState,
  maxHoldingSeconds: number | null,
  thresholds: ExitScoreThresholds = DEFAULT_EXIT_SCORE_THRESHOLDS,
): ExitScoreResult {
  const perDimension: Partial<Record<ExitScoreDimension, number>> = {};
  const assessed: ExitScoreDimension[] = [];
  const unassessed: ExitScoreDimension[] = [];
  const drivers: string[] = [];

  // Rueckgabe vom Hoch. Immer beurteilbar, weil beide Werte zur Position
  // gehoeren und nicht von einem Provider kommen.
  const givebackBps =
    market.highWaterRatio <= 0
      ? 0
      : Math.max(0, ((market.highWaterRatio - market.priceRatio) / market.highWaterRatio) * 10_000);
  const giveback = ramp(givebackBps, 0, thresholds.givebackAtHundredBps);
  perDimension.GIVEBACK = giveback;
  assessed.push("GIVEBACK");
  if (giveback > 50) {
    drivers.push(`${(givebackBps / 100).toFixed(0)} % vom Hoch abgegeben`);
  }

  if (market.volumeAcceleration === null) {
    unassessed.push("MOMENTUM_DECAY");
  } else {
    const decay = ramp(market.volumeAcceleration, 1, thresholds.deadVolumeAcceleration);
    perDimension.MOMENTUM_DECAY = decay;
    assessed.push("MOMENTUM_DECAY");
    if (decay > 50) drivers.push(`Volumen bei Faktor ${market.volumeAcceleration.toFixed(2)}`);
  }

  if (market.liquidityRatio === null) {
    unassessed.push("LIQUIDITY_DRAIN");
  } else {
    const drain = ramp(market.liquidityRatio, 1, thresholds.liquidityFloorRatio);
    perDimension.LIQUIDITY_DRAIN = drain;
    assessed.push("LIQUIDITY_DRAIN");
    if (drain > 50) {
      drivers.push(`Liquiditaet auf ${(market.liquidityRatio * 100).toFixed(0)} % des Einstiegs`);
    }
  }

  if (market.buyRatio === null) {
    unassessed.push("SELL_PRESSURE");
  } else {
    const pressure = ramp(market.buyRatio, 0.5, thresholds.sellPressureFloorBuyRatio);
    perDimension.SELL_PRESSURE = pressure;
    assessed.push("SELL_PRESSURE");
    if (pressure > 50) drivers.push(`Kaeuferanteil ${(market.buyRatio * 100).toFixed(0)} %`);
  }

  if (maxHoldingSeconds === null) {
    unassessed.push("AGE");
  } else {
    const age = ramp(market.holdingSeconds, 0, maxHoldingSeconds);
    perDimension.AGE = age;
    assessed.push("AGE");
  }

  return {
    score: score(combineEvidence(assessed.map((d) => perDimension[d] ?? 0))),
    assessed,
    unassessed,
    perDimension,
    computable: assessed.length >= thresholds.minAssessedDimensions,
    drivers,
  };
}

/**
 * Was der Score allein auslösen darf.
 *
 * Bewusst nur zwei Stufen, und beide zurueckhaltend: der Score ist ein
 * Verdachtsmoment, keine Beobachtung. Er darf enger stellen und teilverkaufen,
 * aber keinen vollstaendigen Ausstieg ausloesen — dafuer braucht es ein
 * Ereignis, das eine der harten Regeln sieht.
 */
export interface ExitScoreBands {
  readonly tightenAbove: number;
  readonly partialExitAbove: number;
}

export const DEFAULT_EXIT_SCORE_BANDS: ExitScoreBands = {
  tightenAbove: 55,
  partialExitAbove: 75,
};

export type ExitScoreAdvice =
  | { readonly kind: "HOLD" }
  | { readonly kind: "TIGHTEN" }
  | { readonly kind: "PARTIAL_EXIT" }
  | { readonly kind: "NO_ADVICE"; readonly reason: "NOT_COMPUTABLE" };

export function adviseFromExitScore(
  result: ExitScoreResult,
  bands: ExitScoreBands = DEFAULT_EXIT_SCORE_BANDS,
): ExitScoreAdvice {
  // Ein nicht belastbarer Score fuehrt zu KEINEM Rat — und ausdruecklich nicht
  // zu „halten". Halten waere ebenfalls eine Entscheidung, und sie waere hier
  // durch nichts gedeckt.
  if (!result.computable) return { kind: "NO_ADVICE", reason: "NOT_COMPUTABLE" };
  if (result.score >= bands.partialExitAbove) return { kind: "PARTIAL_EXIT" };
  if (result.score >= bands.tightenAbove) return { kind: "TIGHTEN" };
  return { kind: "HOLD" };
}

/**
 * Der Score tritt hinter jede feuernde Regel zurueck.
 *
 * Reihenfolge, nicht Verrechnung: eine Regel, die einen vollstaendigen Ausstieg
 * verlangt, wird nicht davon abgeschwaecht, dass der Score niedrig ist. Der
 * Score kommt nur zum Zug, wenn keine Regel etwas zu sagen hat.
 */
export interface CombinedExitDecision {
  readonly source: "RULE" | "SCORE" | "NONE";
  readonly signals: readonly ExitSignal[];
  /** Nur gesetzt, wenn `source === "SCORE"`. */
  readonly advice: ExitScoreAdvice | null;
}

export function combineWithRules(input: {
  readonly ruleSignals: readonly ExitSignal[];
  readonly advice: ExitScoreAdvice;
}): CombinedExitDecision {
  if (input.ruleSignals.length > 0) {
    return { source: "RULE", signals: input.ruleSignals, advice: null };
  }
  if (input.advice.kind === "TIGHTEN" || input.advice.kind === "PARTIAL_EXIT") {
    return { source: "SCORE", signals: [], advice: input.advice };
  }
  return { source: "NONE", signals: [], advice: null };
}
