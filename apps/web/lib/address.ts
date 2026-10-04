/**
 * Was der Betreiber einklebt, und was eine Adresse ist.
 *
 * Gefragt wird nach einer Adresse; eingeklebt wird ein Link — meistens einer
 * von DexScreener, weil genau dort der Coin angeschaut wurde. Eine Eingabe, die
 * daran scheitert, waere formal korrekt und praktisch eine Schikane.
 *
 * Geprueft wird streng, nicht bloss aufgeraeumt: eine Solana-Adresse ist
 * Base58 und 32 bis 44 Zeichen lang. Was das nicht ist, wird abgewiesen, statt
 * als Suchbegriff an die Datenbank zu gehen.
 */

/** Base58 nach Bitcoin-Alphabet: ohne 0, O, I und l. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Holt die Adresse aus der Eingabe, oder `null`.
 *
 * `null` heisst ausdruecklich „das ist keine Adresse" und nicht „nicht
 * gefunden" — die beiden Antworten im Dashboard zu vermengen hiesse, einen
 * Tippfehler als Aussage ueber den Coin zu verkaufen.
 */
export function adresseAusEingabe(eingabe: string): string | null {
  const roh = eingabe.trim();
  if (roh.length === 0) return null;

  // Query und Fragment weg, dann das letzte Pfadstueck. Deckt die Links von
  // DexScreener, Solscan, Birdeye und Jupiter gleichermassen ab, ohne eine
  // Liste von Hosts zu pflegen, die irgendwann veraltet.
  const ohneQuery = roh.split("?")[0]?.split("#")[0] ?? "";
  const stuecke = ohneQuery.split("/").filter((s) => s.length > 0);
  const letztes = stuecke[stuecke.length - 1] ?? "";

  if (BASE58.test(letztes)) return letztes;
  // Manche Links haengen die Adresse nicht ans Ende. Dann gilt das erste
  // Stueck, das wie eine Adresse aussieht — aber nur, wenn es genau eines gibt.
  const kandidaten = stuecke.filter((s) => BASE58.test(s));
  if (kandidaten.length === 1) return kandidaten[0] ?? null;
  return null;
}
