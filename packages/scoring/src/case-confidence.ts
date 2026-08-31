import { score, type Score } from "@sae/core";

import { rampUp } from "./sub-score";

/**
 * Wie gut ist dieser Fall belegt?
 *
 * §21 fragt nach der Anzahl aehnlicher historischer Faelle: „25 gegen 5.000"
 * ist der Unterschied zwischen einer Vermutung und einer Beobachtung.
 *
 * Das ist NICHT dasselbe wie `evIntervalConfidence` (die Breite des
 * Wilson-Intervalls). Verwandt, aber verschieden: viele Faelle mit breiter
 * Streuung heissen „das Muster trennt nicht", wenige Faelle mit enger Streuung
 * heissen „wir wissen es noch nicht". Beide Zahlen hiessen frueher
 * „Confidence" — im Alert waere spaeter nicht mehr erkennbar gewesen, welche
 * dort steht (K-4).
 *
 * Der wichtigste Teil ist `bucketKey`. Die Fallzahl haengt vollstaendig davon
 * ab, wie eng „aehnlich" definiert wird — und eine weitere Definition liefert
 * mehr Faelle und damit hoehere Konfidenz, ohne dass sich am Wissen etwas
 * geaendert haette. Der Schluessel wird deshalb mitgefuehrt und persistiert:
 * eine spaeter aufgeweitete Definition ist so wenigstens sichtbar.
 */

export interface CaseConfidenceInputs {
  /** Wie „aehnlich" definiert wurde. Wird mitgeschrieben, nicht nur benutzt. */
  readonly bucketKey: string;
  /** Abgeschlossene Faelle im Bucket. */
  readonly caseCount: number;
  /**
   * Zeitraum, ueber den die Faelle streuen, in Tagen.
   * 200 Faelle aus einem einzigen Tag sind ein Marktzustand, keine Historie.
   */
  readonly spanDays: number | null;
}

export interface CaseConfidenceThresholds {
  /** Unter dieser Fallzahl ist die Konfidenz 0. */
  readonly casesAtZero: number;
  /** Ab dieser Fallzahl ist sie 100 — mehr hilft nicht mehr wesentlich. */
  readonly casesAtHundred: number;
  /** Ab dieser Streubreite gilt die Historie als hinreichend verteilt. */
  readonly spanDaysAtHundred: number;
}

/**
 * Startwerte, ausdruecklich als Annahmen.
 *
 * 30 als Untergrenze und 500 als Saettigung sind aus der ueblichen Faustregel
 * fuer Anteilsschaetzungen abgeleitet, nicht aus diesen Daten gemessen. Die
 * Saettigung ist bewusst hoch: bei Trefferquoten um 30 % braucht ein
 * Fuenf-Prozentpunkte-Intervall mehrere hundert Beobachtungen.
 */
export const DEFAULT_CASE_CONFIDENCE_THRESHOLDS: CaseConfidenceThresholds = {
  casesAtZero: 30,
  casesAtHundred: 500,
  spanDaysAtHundred: 30,
};

export interface CaseConfidenceResult {
  readonly score: Score;
  readonly bucketKey: string;
  readonly caseCount: number;
  /** Teilwert aus der reinen Fallzahl. */
  readonly countComponent: number;
  /** Teilwert aus der zeitlichen Streuung. `null`, wenn unbekannt. */
  readonly spanComponent: number | null;
  readonly note: string;
}

export function computeCaseConfidence(
  input: CaseConfidenceInputs,
  thresholds: CaseConfidenceThresholds = DEFAULT_CASE_CONFIDENCE_THRESHOLDS,
): CaseConfidenceResult {
  const countComponent = rampUp(
    input.caseCount,
    thresholds.casesAtZero,
    thresholds.casesAtHundred,
  );

  const spanComponent =
    input.spanDays === null ? null : rampUp(input.spanDays, 0, thresholds.spanDaysAtHundred);

  // Das Minimum, nicht der Mittelwert: eine hohe Fallzahl aus einem einzigen
  // Marktzustand ist keine Historie, und ein Mittelwert liesse die grosse Zahl
  // die fehlende Streuung ueberdecken.
  const combined = spanComponent === null ? countComponent : Math.min(countComponent, spanComponent);

  const note =
    input.caseCount < thresholds.casesAtZero
      ? `Nur ${input.caseCount} Faelle im Bucket ${input.bucketKey} — keine Aussage.`
      : spanComponent !== null && spanComponent < countComponent
        ? `${input.caseCount} Faelle, aber nur ${input.spanDays} Tage Streuung — ein Marktzustand.`
        : `${input.caseCount} Faelle im Bucket ${input.bucketKey}.`;

  return {
    score: score(combined),
    bucketKey: input.bucketKey,
    caseCount: input.caseCount,
    countComponent,
    spanComponent,
    note,
  };
}

/**
 * Gesamtkonfidenz aus beiden Groessen.
 *
 * Wieder das Minimum: die schwaechere der beiden begrenzt, was man ueber den
 * Fall sagen kann. Ein Mittelwert wuerde erlauben, eine breite Ergebnisstreuung
 * mit einer grossen Fallzahl zuzudecken — und das ist genau die Situation, in
 * der ein System sich selbst ueberschaetzt.
 */
export function combineConfidence(input: {
  /** 0..1 aus `EvDetail.estimate.evIntervalConfidence`. */
  readonly evIntervalConfidence: number;
  readonly caseConfidence: Score;
}): Score {
  return score(Math.min(input.evIntervalConfidence * 100, input.caseConfidence));
}
