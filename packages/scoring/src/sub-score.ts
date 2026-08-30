import type { Reason, Score } from "@sae/core";

/**
 * Ergebnis eines Teilscores.
 *
 * `NOT_COMPUTABLE` ist ein eigener Fall und ausdruecklich NICHT "50 von 100".
 * Ein neutraler Ersatzwert waere die bequemste Art, fehlende Daten in eine
 * Entscheidung einfliessen zu lassen, ohne dass es jemandem auffaellt: der
 * Endscore saehe unauffaellig aus, obwohl die Haelfte der Grundlage fehlt.
 *
 * `drivers` sagt, WARUM der Score so ausfaellt. Ohne diese Begruendungen ist die
 * spaetere Frage "warum hat das System hier gekauft?" nicht beantwortbar.
 */
export type SubScoreResult =
  | {
      readonly kind: "SCORED";
      readonly score: Score;
      readonly drivers: readonly Reason[];
    }
  | {
      readonly kind: "NOT_COMPUTABLE";
      readonly missing: readonly string[];
    };

export const scored = (score: Score, drivers: readonly Reason[] = []): SubScoreResult => ({
  kind: "SCORED",
  score,
  drivers,
});

export const notComputable = (missing: readonly string[]): SubScoreResult => ({
  kind: "NOT_COMPUTABLE",
  missing,
});

export const isScored = (
  r: SubScoreResult,
): r is Extract<SubScoreResult, { kind: "SCORED" }> => r.kind === "SCORED";

/**
 * Lineare Abbildung eines Werts auf 0..100, begrenzt an den Raendern.
 *
 * Bewusst linear und nicht kurvig: eine Kurve waere ein weiterer freier
 * Parameter, der sich hervorragend zum Ueberanpassen eignet. Solange keine
 * Daten eine Kruemmung rechtfertigen, bleibt es linear.
 */
export function rampUp(value: number, atZero: number, atHundred: number): number {
  if (atHundred === atZero) throw new RangeError("Rampe braucht zwei verschiedene Punkte");
  const t = (value - atZero) / (atHundred - atZero);
  return Math.max(0, Math.min(100, t * 100));
}

/** Wie `rampUp`, nur fallend: hoher Eingabewert bedeutet niedrigen Score. */
export function rampDown(value: number, atHundred: number, atZero: number): number {
  return rampUp(value, atZero, atHundred);
}
