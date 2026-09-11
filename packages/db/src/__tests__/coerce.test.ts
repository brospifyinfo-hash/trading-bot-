import { describe, expect, it } from "vitest";

import { asDate } from "../coerce";

/**
 * Der Absturz, den diese Funktion verhindert, stand im Betriebslog:
 *
 * ```
 * TypeError: a.lastSnapshotAt?.toISOString is not a function
 * ```
 *
 * Die Testumgebung konnte ihn nicht zeigen: PGlite liefert fuer `max(...)` ein
 * `Date`, der Treiber der Produktion eine Zeichenkette. Geprueft wird deshalb
 * ausdruecklich BEIDES — ein Test, der nur den Fall der eigenen Umgebung
 * kennt, haette hier grun gemeldet und nichts abgesichert.
 */

describe("asDate", () => {
  it("nimmt die Zeichenkette, an der die Seite abgestuerzt ist", () => {
    // Genau die Form, die der Treiber in der Produktion liefert.
    const roh = "2026-09-11T20:27:18.972Z";
    const at = asDate(roh);
    expect(at).toBeInstanceOf(Date);
    expect(at?.toISOString()).toBe(roh);
  });

  it("nimmt auch das Date, das die Testumgebung liefert", () => {
    const at = new Date("2026-09-11T20:27:18.972Z");
    // Unveraendert durchgereicht: eine unnoetige Kopie waere nicht falsch,
    // aber sie verschleierte, dass hier nichts umgerechnet wird.
    expect(asDate(at)).toBe(at);
  });

  it("macht aus fehlend weiterhin fehlend", () => {
    expect(asDate(null)).toBeNull();
    expect(asDate(undefined)).toBeNull();
  });

  it("wirft auch bei Unsinn nicht", () => {
    // Der Punkt der ganzen Uebung. Eine Oberflaeche, die wegen eines
    // Zeitstempels abstuerzt, ist schlimmer als eine, die einen Strich zeigt.
    expect(asDate("kein datum")).toBeNull();
    expect(asDate(new Date("kein datum"))).toBeNull();
    expect(asDate(Number.NaN)).toBeNull();
  });

  it("nimmt Millisekunden als Zahl", () => {
    const ms = Date.UTC(2026, 8, 11, 20, 27, 18, 972);
    expect(asDate(ms)?.getTime()).toBe(ms);
  });
});
