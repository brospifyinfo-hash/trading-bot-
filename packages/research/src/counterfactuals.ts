import type { TokenId } from "@sae/core";
import type { BacktestDataSource } from "@sae/backtest";
import type { PositionMarketState } from "@sae/trading";

/**
 * Counterfactuals: „was waere mit einem anderen Ausstieg passiert?"
 *
 * §103 will diese Frage beantworten. I-4 nennt den Grund, warum die Antwort
 * fast immer falsch ist:
 *
 * **Wer den ganzen Kursverlauf kennt, findet immer einen besseren Ausstieg.**
 * „Bei +180 % statt bei +40 % verkaufen" ist keine Regel, sondern eine
 * Beobachtung im Rueckblick. Wertet man Alternativen so aus, sieht jede besser
 * aus als das, was tatsaechlich passiert ist — und das System lernt, seine
 * Ausstiege fuer schlecht zu halten, obwohl es sie gar nicht besser haette
 * treffen koennen.
 *
 * Die einzige belastbare Konstruktion ist deshalb: die Alternative wird Schritt
 * fuer Schritt neu befragt, und sie bekommt an jedem Schritt nur, was zu diesem
 * Zeitpunkt bekannt war. Umgesetzt ist das nicht als Vorsatz, sondern als
 * Schranke — `guardedSource` wirft, wenn jemand Daten jenseits der aktuellen
 * Simulationszeit anfordert.
 */

export class LookAheadError extends Error {
  constructor(requested: Date, clock: Date) {
    super(
      `Counterfactual hat Daten von ${requested.toISOString()} angefordert, ` +
        `die Simulationszeit steht auf ${clock.toISOString()} — das waere Rueckblick, ` +
        "kein Gegenentwurf.",
    );
    this.name = "LookAheadError";
  }
}

/**
 * Umhuellt eine Datenquelle mit einer Uhr.
 *
 * Jede Anfrage mit einem `asOf` nach der aktuellen Simulationszeit wirft. Damit
 * ist Look-Ahead ein Fehler zur Laufzeit und nicht ein besonders gutes Ergebnis.
 */
export function guardedSource(source: BacktestDataSource): {
  readonly source: BacktestDataSource;
  setClock(at: Date): void;
  readonly maxRequested: () => Date | null;
} {
  let clock: Date | null = null;
  let maxRequested: Date | null = null;

  const check = (asOf: Date): void => {
    if (clock !== null && asOf.getTime() > clock.getTime()) {
      throw new LookAheadError(asOf, clock);
    }
    if (maxRequested === null || asOf.getTime() > maxRequested.getTime()) {
      maxRequested = asOf;
    }
  };

  // Bewusst `async`: die Schranke muss als abgelehntes Promise ankommen, nicht
  // als synchroner Wurf. Sonst geht sie an jedem Aufrufer vorbei, der die
  // Methode mit `.catch()` statt `await` benutzt — und das ist genau der
  // Aufrufer, der sie am noetigsten hat.
  const wrapped: BacktestDataSource = {
    async universeAt(asOf) {
      check(asOf);
      return source.universeAt(asOf);
    },
    async featuresAt(tokenId, asOf) {
      check(asOf);
      return source.featuresAt(tokenId, asOf);
    },
    async positionMarketAt(tokenId, entryPrice, entryLiquidity, highWater, holding, asOf) {
      check(asOf);
      return source.positionMarketAt(
        tokenId,
        entryPrice,
        entryLiquidity,
        highWater,
        holding,
        asOf,
      );
    },
    async quoteAt(tokenId, notionalMinor, asOf) {
      check(asOf);
      return source.quoteAt(tokenId, notionalMinor, asOf);
    },
  };

  return {
    source: wrapped,
    setClock: (at: Date) => {
      clock = at;
    },
    maxRequested: () => maxRequested,
  };
}

export interface CounterfactualPosition {
  readonly positionId: string;
  readonly tokenId: TokenId;
  readonly entryPriceUsd: number;
  readonly entryLiquidityUsd: number;
  readonly openedAt: Date;
  readonly closedAt: Date;
  /** Was tatsaechlich realisiert wurde, als Anteil. */
  readonly actualNetReturn: number;
}

/** Eine Ausstiegsalternative. Sieht nur den aktuellen Zustand, keine Zukunft. */
export interface CounterfactualRule {
  readonly id: string;
  shouldExit(state: PositionMarketState): boolean;
}

export interface CounterfactualResult {
  readonly positionId: string;
  readonly ruleId: string;
  /** Wann die Alternative ausgestiegen waere. `null` = gar nicht. */
  readonly exitAt: Date | null;
  /** Rendite der Alternative, als Anteil. `null` = nicht bestimmbar. */
  readonly counterfactualReturn: number | null;
  readonly actualNetReturn: number;
  /** Alternative minus tatsaechlich. Positiv heisst: waere besser gewesen. */
  readonly delta: number | null;
  readonly stepsEvaluated: number;
  /** Spaetester angefragter Zeitpunkt. Nie nach dem Ausstieg. */
  readonly maxAsOfRequested: Date | null;
  readonly note: string;
}

export interface CounterfactualSettings {
  /** Schrittweite der Nachsimulation. */
  readonly stepSeconds: number;
  /** Obergrenze an Schritten, damit ein Lauf nicht unbegrenzt waechst. */
  readonly maxSteps: number;
}

export const DEFAULT_COUNTERFACTUAL_SETTINGS: CounterfactualSettings = {
  stepSeconds: 60,
  maxSteps: 2_000,
};

/**
 * Spielt eine Ausstiegsalternative nach.
 *
 * Die Alternative wird an jedem Schritt neu gefragt und sieht nur den Zustand
 * zu diesem Schritt. Steigt sie nicht aus, wird die Position am tatsaechlichen
 * Schlusszeitpunkt bewertet — und ausdruecklich nicht am spaeteren Hoch.
 */
export async function runCounterfactualExit(input: {
  readonly position: CounterfactualPosition;
  readonly rule: CounterfactualRule;
  readonly source: BacktestDataSource;
  readonly settings?: Partial<CounterfactualSettings>;
}): Promise<CounterfactualResult> {
  const settings = { ...DEFAULT_COUNTERFACTUAL_SETTINGS, ...input.settings };
  const guard = guardedSource(input.source);
  const { position } = input;

  let highWaterRatio = 1;
  let steps = 0;
  let exitAt: Date | null = null;
  let exitRatio: number | null = null;

  for (
    let t = position.openedAt.getTime() + settings.stepSeconds * 1_000;
    t <= position.closedAt.getTime() && steps < settings.maxSteps;
    t += settings.stepSeconds * 1_000
  ) {
    const asOf = new Date(t);
    guard.setClock(asOf);
    steps += 1;

    const state = await guard.source.positionMarketAt(
      position.tokenId,
      position.entryPriceUsd,
      position.entryLiquidityUsd,
      highWaterRatio,
      (t - position.openedAt.getTime()) / 1_000,
      asOf,
    );
    if (state === null) continue;

    if (state.priceRatio > highWaterRatio) highWaterRatio = state.priceRatio;

    if (input.rule.shouldExit(state)) {
      exitAt = asOf;
      exitRatio = state.priceRatio;
      break;
    }
  }

  if (exitRatio === null) {
    return {
      positionId: position.positionId,
      ruleId: input.rule.id,
      exitAt: null,
      counterfactualReturn: null,
      actualNetReturn: position.actualNetReturn,
      delta: null,
      stepsEvaluated: steps,
      maxAsOfRequested: guard.maxRequested(),
      note:
        steps === 0
          ? "Kein Kursverlauf im Haltezeitraum — keine Aussage."
          : "Die Alternative waere nicht ausgestiegen; bewertet wird dann der tatsaechliche Schluss.",
    };
  }

  // Bruttorendite der Alternative. Die Ausfuehrungskosten des Gegenentwurfs
  // muessen vom Aufrufer mit demselben Kostenmodell abgezogen werden — hier
  // wird bewusst keine kostenfreie Alternative gegen einen kostenbehafteten
  // Ist-Wert gestellt.
  const counterfactualReturn = exitRatio - 1;

  return {
    positionId: position.positionId,
    ruleId: input.rule.id,
    exitAt,
    counterfactualReturn,
    actualNetReturn: position.actualNetReturn,
    delta: counterfactualReturn - position.actualNetReturn,
    stepsEvaluated: steps,
    maxAsOfRequested: guard.maxRequested(),
    note:
      `Ausstieg nach ${Math.round((exitAt!.getTime() - position.openedAt.getTime()) / 60_000)} min ` +
      "bei dem Zustand, der zu diesem Zeitpunkt bekannt war. Brutto — Kosten sind noch abzuziehen.",
  };
}

export interface CounterfactualSummary {
  readonly ruleId: string;
  readonly evaluated: number;
  readonly betterCount: number;
  readonly worseCount: number;
  readonly medianDelta: number | null;
  readonly verdict: "BETTER" | "WORSE" | "NO_DIFFERENCE" | "TOO_LITTLE_DATA";
  readonly note: string;
}

export const MIN_COUNTERFACTUALS_FOR_VERDICT = 50;

/**
 * Fasst mehrere Gegenentwuerfe zusammen.
 *
 * Median statt Mittelwert: ein einzelner Verzehnfacher, den die Alternative
 * laufen gelassen haette, wuerde jeden Mittelwert bestimmen — und genau dieser
 * eine Fall ist der, den man im Rueckblick immer findet.
 */
export function summarizeCounterfactuals(
  ruleId: string,
  results: readonly CounterfactualResult[],
): CounterfactualSummary {
  const deltas = results
    .map((r) => r.delta)
    .filter((d): d is number => d !== null);

  if (deltas.length < MIN_COUNTERFACTUALS_FOR_VERDICT) {
    return {
      ruleId,
      evaluated: deltas.length,
      betterCount: 0,
      worseCount: 0,
      medianDelta: null,
      verdict: "TOO_LITTLE_DATA",
      note: `${deltas.length} auswertbare Faelle, mindestens ${MIN_COUNTERFACTUALS_FOR_VERDICT} noetig.`,
    };
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianDelta =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;

  const betterCount = deltas.filter((d) => d > 0).length;
  const worseCount = deltas.filter((d) => d < 0).length;

  // Eine Alternative gilt nur dann als besser, wenn sie in der MEHRHEIT der
  // Faelle besser war — nicht, wenn ein einzelner Fall den Median hebt.
  const share = betterCount / deltas.length;
  const verdict: CounterfactualSummary["verdict"] =
    share > 0.55 && medianDelta > 0 ? "BETTER" : share < 0.45 && medianDelta < 0 ? "WORSE" : "NO_DIFFERENCE";

  return {
    ruleId,
    evaluated: deltas.length,
    betterCount,
    worseCount,
    medianDelta,
    verdict,
    note:
      `${betterCount} besser, ${worseCount} schlechter, Median ` +
      `${(medianDelta * 100).toFixed(1)} Punkte.`,
  };
}
