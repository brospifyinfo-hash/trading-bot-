/**
 * Was der Treiber liefert, in das umwandeln, was der Typ behauptet.
 *
 * ### Der Anlass
 *
 * Die Startseite stuerzte im Betrieb ab:
 *
 * ```
 * TypeError: a.lastSnapshotAt?.toISOString is not a function
 * ```
 *
 * Dahinter stand `sql<Date | null>\`max(${tokenSnapshots.observedAt})\``. Das
 * spitze Klammerpaar ist eine **Behauptung ueber den Typ, keine Umwandlung**.
 * Bei einer normalen Spaltenauswahl trifft sie zu, weil Drizzle den
 * Spaltentyp kennt und abbildet. Bei einem rohen Ausdruck wie `max(...)` kennt
 * er ihn nicht — und was ankommt, haengt am Treiber: unter PGlite ein `Date`,
 * in der Produktion eine Zeichenkette.
 *
 * Damit war der Fehler in der einen Umgebung unsichtbar, in der es Tests gibt,
 * und sicher in der anderen, in der es Nutzer gibt. Dieselbe Klasse wie die
 * Regel `sae/no-date-in-sql`, die es hier schon gibt.
 *
 * ### Warum nicht an der Anzeigestelle reparieren
 *
 * Naheliegend waere `new Date(x).toISOString()` dort, wo es knallt. Das waere
 * dreifach schlecht: es heilt genau ein Feld, waehrend zwei weitere Stellen
 * dieselbe Behauptung aufstellen; es laesst die Luege im Typ stehen, sodass
 * der naechste Aufrufer wieder hineinlaeuft; und `new Date(undefined)` ergibt
 * ein ungueltiges Datum, dessen `toISOString()` erneut wirft — der Patch
 * haette den Absturz nur verschoben.
 *
 * Repariert wird deshalb an der Grenze, an der die Daten hereinkommen. Der Typ
 * sagt dort ab jetzt die Wahrheit (`Date | string | null`), und weil eine
 * Zeichenkette kein `toISOString` hat, ZWINGT der Compiler jeden Aufrufer zur
 * Umwandlung. Aus einem Laufzeitabsturz wird ein Uebersetzungsfehler.
 */

/**
 * `Date | null` aus dem, was ein Treiber fuer einen Zeitstempel zurueckgibt.
 *
 * Wirft unter keinen Umstaenden. Eine Oberflaeche, die wegen eines
 * Zeitstempels abstuerzt, ist schlimmer als eine, die an einer Stelle einen
 * Strich zeigt.
 *
 * Unlesbares wird zu `null` und damit wie „nicht vorhanden" behandelt. Das ist
 * die einzige Stelle, an der hier etwas eingeebnet wird, und sie ist bewusst
 * gewaehlt: die Alternative waere ein Wurf, und genau den soll diese Funktion
 * verhindern.
 */
export function asDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
