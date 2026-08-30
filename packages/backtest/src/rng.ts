/**
 * Deterministischer Zufallsgenerator.
 *
 * `Math.random` hat im Backtest nichts zu suchen: ein Lauf, der bei jeder
 * Wiederholung ein anderes Ergebnis liefert, ist keine Messung, sondern eine
 * Anekdote. Man kann ihn nicht gegen einen frueheren Lauf halten, und man kann
 * auch nicht sagen, ob eine Verbesserung von der Aenderung kommt oder vom Wuerfel.
 *
 * mulberry32 — klein, schnell, ausreichend gleichverteilt fuer Fill-Simulation.
 * Kryptografisch ist er nicht, muss er hier auch nicht sein.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Ziehung fuer die Preisdrift zwischen Quote und Fill.
 *
 * Halbnormal statt gleichverteilt: kleine Abweichungen sind haeufig, grosse
 * selten — das entspricht dem beobachteten Verhalten besser als eine
 * Gleichverteilung, die zu viele mittlere Faelle erzeugt.
 *
 * Die Skalierung ist eine ANNAHME, bis sie gegen reale Ausfuehrungen kalibriert
 * ist. Sie ist der unsicherste Parameter des ganzen Modells.
 */
export function halfNormalDrift(random: () => number, scale: number): number {
  // Box-Muller, nur der Betrag.
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.abs(z) * scale;
}
