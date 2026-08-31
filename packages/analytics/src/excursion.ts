/**
 * Wie gut war der Ein- und der Ausstieg — unabhaengig davon, ob der Trade
 * gewonnen hat.
 *
 * Ein Gewinn sagt wenig ueber die Ausfuehrung: wer bei +300 % haette verkaufen
 * koennen und bei +20 % ausgestiegen ist, hat gewonnen und trotzdem schlecht
 * gehandelt. Umgekehrt kann ein Verlust sauber ausgefuehrt sein. §36 bis §39
 * trennen deshalb vier Groessen, die alle aus demselben Kursverlauf kommen:
 *
 *   MFE  hoechster Punkt nach dem Einstieg  — was moeglich war
 *   MAE  tiefster Punkt nach dem Einstieg   — was man ausgehalten hat
 *   Exit Efficiency  realisiert / MFE       — wie viel davon geholt wurde
 *   Entry Quality    Rueckgang VOR dem Hoch — ob der Einstieg zu frueh war
 *
 * Der entscheidende Unterschied steckt in der letzten Zeile: fuer die
 * Einstiegsqualitaet zaehlt nur der Rueckgang VOR dem Hoch. Ein Einbruch danach
 * ist ein Ausstiegsproblem. Wer beides in einen MAE-Wert wirft, macht aus einem
 * verpassten Ausstieg einen schlechten Einstieg — und optimiert anschliessend
 * die falsche Seite.
 */

export interface PricePoint {
  readonly at: Date;
  readonly priceUsd: number;
}

export interface ExcursionInputs {
  readonly entryPriceUsd: number;
  readonly entryAt: Date;
  /** Kursverlauf NACH dem Einstieg, aufsteigend nach Zeit. */
  readonly path: readonly PricePoint[];
  /** Realisierter Ausstiegskurs. `null`, solange die Position offen ist. */
  readonly exitPriceUsd: number | null;
}

export interface ExcursionResult {
  /** Hoechster Punkt als Anteil. Negativ, wenn der Kurs nie ueber Einstieg war. */
  readonly mfe: number | null;
  /** Tiefster Punkt als Anteil. 0, wenn der Kurs nie darunter war. */
  readonly mae: number | null;
  /** Rueckgang vor dem Hoch — die Groesse, die den Einstieg beurteilt. */
  readonly maeBeforePeak: number | null;
  /** Rueckgang nach dem Hoch — die Groesse, die den Ausstieg beurteilt. */
  readonly maeAfterPeak: number | null;
  readonly realizedReturn: number | null;
  /**
   * Anteil des erreichbaren Gewinns, der realisiert wurde.
   * `null`, wenn es nie einen Gewinn zu holen gab — nicht 0 und nicht 1.
   */
  readonly exitEfficiency: number | null;
  /** 0..1. 1 = kein Rueckgang vor dem Hoch. `null` ohne Hoch ueber Einstieg. */
  readonly entryQuality: number | null;
  readonly secondsToPeak: number | null;
  readonly secondsToTrough: number | null;
  readonly pathPoints: number;
}

const EMPTY: ExcursionResult = {
  mfe: null,
  mae: null,
  maeBeforePeak: null,
  maeAfterPeak: null,
  realizedReturn: null,
  exitEfficiency: null,
  entryQuality: null,
  secondsToPeak: null,
  secondsToTrough: null,
  pathPoints: 0,
};

export function computeExcursions(input: ExcursionInputs): ExcursionResult {
  if (input.entryPriceUsd <= 0) {
    throw new RangeError(`Einstiegskurs muss positiv sein, war ${input.entryPriceUsd}`);
  }
  if (input.path.length === 0) return EMPTY;

  // Unsortierte Eingaben werden NICHT stillschweigend sortiert: die Reihenfolge
  // entscheidet ueber „vor dem Hoch" und „nach dem Hoch", und ein sortierender
  // Aufruf wuerde einen Fehler in der Zeitreihenabfrage unsichtbar machen.
  for (let i = 1; i < input.path.length; i += 1) {
    if (input.path[i]!.at.getTime() < input.path[i - 1]!.at.getTime()) {
      throw new RangeError("Kursverlauf ist nicht aufsteigend sortiert");
    }
  }
  if (input.path[0]!.at.getTime() < input.entryAt.getTime()) {
    throw new RangeError("Kursverlauf beginnt vor dem Einstieg");
  }

  const asFraction = (price: number): number => price / input.entryPriceUsd - 1;

  let peakIndex = 0;
  let troughIndex = 0;
  for (let i = 1; i < input.path.length; i += 1) {
    if (input.path[i]!.priceUsd > input.path[peakIndex]!.priceUsd) peakIndex = i;
    if (input.path[i]!.priceUsd < input.path[troughIndex]!.priceUsd) troughIndex = i;
  }

  const mfe = asFraction(input.path[peakIndex]!.priceUsd);
  const mae = Math.min(0, asFraction(input.path[troughIndex]!.priceUsd));

  let lowBeforePeak = 0;
  for (let i = 0; i <= peakIndex; i += 1) {
    lowBeforePeak = Math.min(lowBeforePeak, asFraction(input.path[i]!.priceUsd));
  }
  let lowAfterPeak = 0;
  for (let i = peakIndex; i < input.path.length; i += 1) {
    lowAfterPeak = Math.min(lowAfterPeak, asFraction(input.path[i]!.priceUsd));
  }

  const realizedReturn =
    input.exitPriceUsd === null ? null : asFraction(input.exitPriceUsd);

  // Ohne Hoch ueber dem Einstieg gab es nichts zu holen. Dann ist die
  // Ausstiegseffizienz nicht 0 (das hiesse „alles verpasst") und nicht 1
  // (das hiesse „perfekt"), sondern undefiniert.
  const exitEfficiency =
    realizedReturn === null || mfe <= 0 ? null : Math.min(1, realizedReturn / mfe);

  // Wie viel Rueckgang hat der Einstieg gekostet, gemessen an dem, was danach
  // kam. Kein Rueckgang vor dem Hoch = 1.
  const entryQuality = mfe <= 0 ? null : mfe / (mfe - lowBeforePeak);

  return {
    mfe,
    mae,
    maeBeforePeak: lowBeforePeak,
    maeAfterPeak: lowAfterPeak,
    realizedReturn,
    exitEfficiency,
    entryQuality,
    secondsToPeak:
      (input.path[peakIndex]!.at.getTime() - input.entryAt.getTime()) / 1_000,
    secondsToTrough:
      (input.path[troughIndex]!.at.getTime() - input.entryAt.getTime()) / 1_000,
    pathPoints: input.path.length,
  };
}

/**
 * Zusammenfassung ueber mehrere Positionen.
 *
 * Bewusst Mediane statt Mittelwerte: bei Memecoins zieht ein einzelner
 * Verzehnfacher jeden Mittelwert so weit hoch, dass die Kennzahl nur noch
 * diesen einen Trade beschreibt.
 */
export interface ExcursionSummary {
  readonly count: number;
  readonly medianMfe: number | null;
  readonly medianMae: number | null;
  readonly medianExitEfficiency: number | null;
  readonly medianEntryQuality: number | null;
  /** Anteil der Trades, die ueber den Einstieg gestiegen sind. */
  readonly shareWithUpside: number | null;
}

export function summarizeExcursions(
  results: readonly ExcursionResult[],
): ExcursionSummary {
  if (results.length === 0) {
    return {
      count: 0,
      medianMfe: null,
      medianMae: null,
      medianExitEfficiency: null,
      medianEntryQuality: null,
      shareWithUpside: null,
    };
  }

  const withPath = results.filter((r) => r.pathPoints > 0);
  if (withPath.length === 0) {
    return {
      count: results.length,
      medianMfe: null,
      medianMae: null,
      medianExitEfficiency: null,
      medianEntryQuality: null,
      shareWithUpside: null,
    };
  }

  return {
    count: results.length,
    medianMfe: medianOf(withPath.map((r) => r.mfe)),
    medianMae: medianOf(withPath.map((r) => r.mae)),
    medianExitEfficiency: medianOf(withPath.map((r) => r.exitEfficiency)),
    medianEntryQuality: medianOf(withPath.map((r) => r.entryQuality)),
    shareWithUpside:
      withPath.filter((r) => (r.mfe ?? 0) > 0).length / withPath.length,
  };
}

function medianOf(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  if (present.length % 2 === 1) return present[mid]!;
  return (present[mid - 1]! + present[mid]!) / 2;
}
