/**
 * Aus einem Router-Quote einen Preis mit BEKANNTEM Alter machen.
 *
 * Das ist der Kern des Wegs, der die letzte grosse Luecke schliesst. Zur
 * Erinnerung, warum es sie gibt (DECISIONS §89, §94): DexScreener liefert
 * keinen Messzeitpunkt. Ein Preis ohne Alter traegt keine
 * Einstiegsentscheidung, und ein erfundenes Alter ist schlimmer als keins.
 *
 * Ein Quote loest beides auf einmal:
 *
 * - Er nennt mit `contextSlot` den Slot, zu dem er aus dem Kettenzustand
 *   gerechnet wurde. Ueber `getBlockTime(slot)` wird daraus eine echte Uhrzeit
 *   — nicht geschaetzt, sondern von der Kette abgelesen.
 * - Er ist ausserdem der Preis, zu dem tatsaechlich getauscht wuerde,
 *   einschliesslich Route und Preiseinfluss. Ein Pool-Mittelpreis ist das
 *   nicht.
 *
 * Diese Datei rechnet nur. Sie ruft niemanden auf, kennt keinen Anbieter und
 * ist damit vollstaendig pruefbar — was wichtig ist, weil hier die
 * gefaehrlichen Fehler wohnen: eine vertauschte Dezimalstelle verschiebt einen
 * Preis um Zehnerpotenzen und sieht dabei voellig plausibel aus.
 */

/** Was ein Quote an nachrechenbaren Zahlen hergibt. */
export interface QuoteMeasurement {
  /** Eingesetzte Menge in kleinster Einheit. */
  readonly inAmountRaw: bigint;
  readonly inDecimals: number;
  /** Erhaltene Menge in kleinster Einheit. */
  readonly outAmountRaw: bigint;
  readonly outDecimals: number;
}

/**
 * Zusatzstellen fuer die Ganzzahl-Division.
 *
 * Ohne sie waere `outRaw / inRaw` bei jedem Preis unter 1 schlicht 0. Zwoelf
 * Stellen decken den Bereich ab, in dem Memecoins gehandelt werden
 * (Bruchteile eines Cents) und bleiben weit unter der Grenze, ab der die
 * Umwandlung nach `number` an Genauigkeit verliert.
 */
const PRECISION = 10n ** 12n;
const MAX_DECIMALS = 32;

/**
 * Preis einer Einheit — in der Waehrung der Ausgabeseite.
 *
 * Gegen USDC gerechnet ist das der Dollarpreis. Gegen SOL waere es ein
 * SOL-Preis, und ihn als Dollarpreis zu fuehren waere derselbe Fehler, den
 * `UNUSABLE_QUOTE` in der Marktauswahl verhindert.
 *
 * `null` heisst unbekannt, nicht null. Es gibt hier keinen Ersatzwert.
 */
export function quoteUnitPrice(m: QuoteMeasurement): number | null {
  if (m.inAmountRaw <= 0n || m.outAmountRaw <= 0n) return null;
  if (!validDecimals(m.inDecimals) || !validDecimals(m.outDecimals)) return null;

  // (out / 10^outDec) / (in / 10^inDec)  ausmultipliziert, damit bis zur
  // letzten Division alles ganzzahlig bleibt.
  const numerator = m.outAmountRaw * 10n ** BigInt(m.inDecimals) * PRECISION;
  const denominator = m.inAmountRaw * 10n ** BigInt(m.outDecimals);
  if (denominator === 0n) return null;

  const price = Number(numerator / denominator) / Number(PRECISION);
  // Ein nicht endlicher Preis ist kein Preis. Er entstuende bei absurden
  // Groessenordnungen und darf nicht als Zahl weitergereicht werden.
  return Number.isFinite(price) && price > 0 ? price : null;
}

function validDecimals(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= MAX_DECIMALS;
}

/**
 * Wie alt ist die Messung?
 *
 * Ausdruecklich ein eigener Ergebnistyp statt `number | null`: „unbekannt"
 * und „die Uhren stehen falsch" sind verschiedene Befunde mit verschiedenen
 * Gegenmassnahmen, und der zweite darf nicht als der erste durchgehen.
 */
export type QuoteAge =
  | { readonly kind: "KNOWN"; readonly seconds: number }
  /** Der Anbieter hat keinen Slot mitgeliefert. */
  | { readonly kind: "NO_CONTEXT_SLOT" }
  /** Der Slot ist bekannt, seine Uhrzeit nicht. */
  | { readonly kind: "NO_SLOT_TIME" }
  /**
   * Die Messung liegt in der Zukunft.
   *
   * Nicht auf 0 gekappt: eine Messung aus der Zukunft heisst, dass eine der
   * beiden Uhren falsch geht — und dann stimmt auch jedes positive Alter
   * nicht. Gekappt saehe der Fall wie „taufrisch" aus, also ausgerechnet wie
   * das beste denkbare Ergebnis.
   */
  | { readonly kind: "CLOCK_SKEW"; readonly seconds: number };

export function quoteAge(input: {
  /** Aus dem Quote. `null`, wenn der Anbieter keinen liefert. */
  readonly contextSlot: number | null;
  /** Uhrzeit dieses Slots, von der Kette gelesen. `null`, wenn nicht abrufbar. */
  readonly slotTime: Date | null;
  /** Wann WIR die Antwort hatten. */
  readonly receivedAt: Date;
}): QuoteAge {
  if (input.contextSlot === null) return { kind: "NO_CONTEXT_SLOT" };
  if (input.slotTime === null) return { kind: "NO_SLOT_TIME" };

  const seconds = (input.receivedAt.getTime() - input.slotTime.getTime()) / 1_000;
  if (seconds < 0) return { kind: "CLOCK_SKEW", seconds };
  return { kind: "KNOWN", seconds };
}

/**
 * Das Alter in der Form, die der Snapshot-Pfad erwartet.
 *
 * Nur `KNOWN` wird zu einer Zahl. Alles andere bleibt `null` — und `null`
 * heisst dort UNBEKANNT, worauf der Torwaechter `snapshotSupportsEntry`
 * korrekt mit einer Ablehnung reagiert.
 */
export function ageToFreshnessSeconds(age: QuoteAge): number | null {
  return age.kind === "KNOWN" ? age.seconds : null;
}
