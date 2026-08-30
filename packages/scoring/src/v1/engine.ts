import { score, type Reason, type Score, type TokenId } from "@sae/core";
import { collectMissing, countFields, type FeatureVector, type MissingField } from "../features";
import { isScored, type SubScoreResult } from "../sub-score";
import {
  devScore,
  executionScore,
  holderScore,
  liquidityScore,
  momentumScore,
  narrativeScore,
  securityScore,
  smartMoneyScore,
  socialScore,
} from "./sub-scores";

/**
 * Score-Engine v1.0.0.
 *
 * Die Version steht an jedem erzeugten Datensatz. Aendert sich hier etwas,
 * bekommt sie eine neue Nummer — sonst waeren alte und neue Scores in derselben
 * Statistik, und die Auswertung waere wertlos.
 *
 * WICHTIG: Die Gewichte unten sind begruendete Ausgangswerte, KEINE validierten
 * Parameter. Sie stammen aus Ueberlegung, nicht aus Daten. Genau deshalb gibt es
 * das Research-Dashboard: es soll zeigen, welche Faktoren tatsaechlich
 * Erwartungswert erzeugen — und die Gewichte danach korrigieren, nicht umgekehrt.
 */
export const SCORE_ENGINE_VERSION = "1.0.0";

export const WEIGHTS = {
  security: 0.2,
  liquidity: 0.15,
  momentum: 0.15,
  holder: 0.1,
  execution: 0.1,
  smartMoney: 0.12,
  social: 0.06,
  dev: 0.07,
  narrative: 0.05,
} as const;

export type SubScoreName = keyof typeof WEIGHTS;

export interface ScoringResult {
  readonly tokenId: TokenId;
  readonly asOf: Date;
  readonly scoreEngineVersion: string;
  readonly subScores: Readonly<Record<SubScoreName, SubScoreResult>>;
  /**
   * Gewichteter Score ueber die BERECHENBAREN Teilscores.
   *
   * `null`, wenn zu wenig Gewicht abgedeckt ist — ein Endscore aus zwei von neun
   * Teilscores waere eine Zahl ohne Aussage, und eine Zahl ohne Aussage ist
   * gefaehrlicher als gar keine.
   */
  readonly finalScore: Score | null;
  /**
   * Anteil des Gesamtgewichts, der tatsaechlich berechnet werden konnte.
   * Geht als eigenes Hard Gate in die Entscheidung ein.
   */
  readonly weightCoverage: number;
  /** Anteil der vorhandenen Eingabefelder. */
  readonly dataCompleteness: number;
  readonly missingFields: readonly MissingField[];
  readonly drivers: readonly Reason[];
  readonly notComputable: readonly SubScoreName[];
}

/** Unter dieser Gewichtsabdeckung wird kein Endscore gebildet. */
export const MIN_WEIGHT_COVERAGE = 0.6;

export function computeScores(vector: FeatureVector): ScoringResult {
  const subScores: Record<SubScoreName, SubScoreResult> = {
    security: securityScore(vector),
    liquidity: liquidityScore(vector),
    momentum: momentumScore(vector),
    holder: holderScore(vector),
    execution: executionScore(vector),
    smartMoney: smartMoneyScore(vector),
    social: socialScore(vector),
    dev: devScore(vector),
    narrative: narrativeScore(vector),
  };

  let weightedSum = 0;
  let coveredWeight = 0;
  const drivers: Reason[] = [];
  const notComputableNames: SubScoreName[] = [];

  for (const [name, weight] of Object.entries(WEIGHTS) as Array<[SubScoreName, number]>) {
    const result = subScores[name];
    if (isScored(result)) {
      weightedSum += result.score * weight;
      coveredWeight += weight;
      drivers.push(...result.drivers);
    } else {
      notComputableNames.push(name);
    }
  }

  // Normiert auf das abgedeckte Gewicht. Ohne diese Normierung wuerde ein Token
  // mit fehlenden Teilscores automatisch schlecht aussehen — was genauso falsch
  // waere wie automatisch gut.
  const weightCoverage = coveredWeight;
  const finalScore =
    coveredWeight >= MIN_WEIGHT_COVERAGE ? score(weightedSum / coveredWeight) : null;

  const missingFields = collectMissing(vector);
  const dataCompleteness = 1 - missingFields.length / countFields(vector);

  return {
    tokenId: vector.tokenId,
    asOf: vector.asOf,
    scoreEngineVersion: SCORE_ENGINE_VERSION,
    subScores,
    finalScore,
    weightCoverage,
    dataCompleteness,
    missingFields,
    drivers,
    notComputable: notComputableNames,
  };
}

/**
 * Gewichte muessen sich zu 1 summieren, sonst ist die Normierung schief.
 * Wird beim Laden geprueft, damit ein Tippfehler nicht still die Skala verschiebt.
 */
export function assertWeightsSumToOne(): void {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new RangeError(`Score-Gewichte summieren sich zu ${sum}, erwartet 1`);
  }
}

assertWeightsSumToOne();
