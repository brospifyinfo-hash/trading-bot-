/**
 * Korrektur fuer vielfaches Testen.
 *
 * Der Grund, warum Faktoranalyse ohne diese Korrektur eine Maschine zur
 * Erzeugung von Scheinbefunden ist: bei 45 Features und je drei Schwellen sind
 * das 135 Hypothesen. Auf dem ueblichen 5-%-Niveau erwartet man rund sieben
 * „signifikante" Ergebnisse allein durch Zufall — und die sehen genauso aus wie
 * echte.
 *
 * Wer anschliessend die sieben schoensten davon in eine Strategie einbaut, hat
 * Rauschen fest verdrahtet und wird es erst im Live-Betrieb merken.
 *
 * Umgesetzt ist die konservative Bonferroni-Variante: das Niveau wird durch die
 * Zahl der Vergleiche geteilt. Sie ist strenger als noetig, und das ist hier die
 * richtige Richtung — ein uebersehener echter Faktor kostet eine verpasste
 * Chance, ein falsch bestaetigter kostet Geld.
 */

/** Standardniveau. Bewusst benannt, damit es nicht im Code verstreut auftaucht. */
export const DEFAULT_ALPHA = 0.05;

/**
 * Quantil der Standardnormalverteilung.
 *
 * Rationale Naeherung nach Acklam; Fehler unter 1,15e-9 im offenen Intervall.
 * Deterministisch — dieselbe Eingabe liefert immer dasselbe Ergebnis, was fuer
 * reproduzierbare Forschungslaeufe noetig ist.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError(`p muss in (0,1) liegen, war ${p}`);

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
             -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
             3.754408661907416e0];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * z-Wert fuer ein zweiseitiges Intervall bei `comparisons` gleichzeitigen Tests.
 *
 * Bei einem einzigen Test ergibt sich das vertraute 1,96. Bei 135 Tests sind es
 * rund 3,5 — die Intervalle werden deutlich breiter, und genau das ist der
 * Zweck: ein Befund muss staerker sein, um sich gegen die Zahl der Versuche
 * durchzusetzen.
 */
export function adjustedZ(comparisons: number, alpha: number = DEFAULT_ALPHA): number {
  if (comparisons < 1 || !Number.isInteger(comparisons)) {
    throw new RangeError(`comparisons muss eine positive ganze Zahl sein, war ${comparisons}`);
  }
  if (alpha <= 0 || alpha >= 1) throw new RangeError(`alpha muss in (0,1) liegen, war ${alpha}`);
  return normalQuantile(1 - alpha / (2 * comparisons));
}

/**
 * Wie viele Scheinbefunde bei dieser Zahl von Tests zu erwarten waeren.
 *
 * Fuer Berichte: die Zahl neben einem Ergebnis stehen zu haben, macht den
 * Unterschied zwischen „drei Faktoren gefunden" und „drei Faktoren gefunden,
 * sieben waeren zufaellig zu erwarten gewesen".
 */
export function expectedFalsePositives(
  comparisons: number,
  alpha: number = DEFAULT_ALPHA,
): number {
  return comparisons * alpha;
}
