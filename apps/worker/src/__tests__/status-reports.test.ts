import { describe, expect, it } from "vitest";
import { summarizeFleet } from "@sae/providers";

import { toStatusReports } from "../handlers";

/**
 * Die Naht zwischen gemessener Anbieterlage und Entscheidungsmaschine.
 *
 * Hier sass ein Fehler, der im Betrieb wie ein Ausfall aussah und keiner war:
 * die Abbildung setzte `capabilities: []`. `summarizeFleet` filtert darauf,
 * eine leere Liste ergibt eine leere Auswahl, und `signalValidity` schliesst
 * daraufhin beide Papier-Stroeme mit `NO_MARKET_DATA`.
 *
 * Sichtbar wurde es an einem Widerspruch in EINEM Prozess, zwanzig Sekunden
 * auseinander:
 *
 *   Marktdaten aufgefrischt  ingested: 5  entryReady: 5  exitProbe: OK=5
 *   Gelegenheiten geprueft   reasons: BLOCKED_NO_MARKET_DATA=5
 *
 * Geprueft wird deshalb die Abbildung selbst und nicht der Durchlauf: der
 * Verdrahtungstest kommt ohne Historie nie bis zu dieser Stelle, weil die
 * Kette vorher bei `NO_FEATURE_VECTOR` anhaelt.
 */

/** Eine Zeile, wie `provider_status_samples` sie traegt. */
function zeile(over: Partial<Parameters<typeof toStatusReports>[0][number]> = {}) {
  return {
    providerId: "dexscreener",
    status: "CONNECTED",
    capabilities: ["TOKEN_MARKET"],
    lastSuccessAt: new Date("2026-09-12T20:21:17.951Z"),
    lastFailureAt: null,
    lastFailureReason: null,
    latencyMsP50: 19,
    latencyMsP95: 42,
    dataFreshnessSeconds: null,
    detail: null,
    ...over,
  };
}

describe("Anbieterlage fuer die Entscheidungsmaschine", () => {
  it("traegt die gemessenen Faehigkeiten weiter", () => {
    const [report] = toStatusReports([zeile()]);
    expect(report?.capabilities).toEqual(["TOKEN_MARKET"]);
  });

  it("laesst einen verbundenen Marktdatenanbieter als solchen durch", () => {
    // Der eigentliche Punkt: dieselbe Rechnung, die im Betrieb
    // `NO_MARKET_DATA` ergab.
    const fleet = summarizeFleet(toStatusReports([zeile()]));
    expect(fleet.anyMarketDataConnected).toBe(true);
    expect(fleet.anyMarketDataUsable).toBe(true);
  });

  it("meldet ohne Faehigkeit KEINE Marktdaten — und das ist richtig so", () => {
    // Die Gegenprobe. Ohne sie liesse sich nicht unterscheiden, ob die
    // Pruefung greift oder ob sie alles durchwinkt.
    const fleet = summarizeFleet(toStatusReports([zeile({ capabilities: [] })]));
    expect(fleet.anyMarketDataUsable).toBe(false);
  });

  it("haelt eine unlesbare Spalte fuer leer statt zu werfen", () => {
    // `jsonb` kann alles enthalten. Ein Wurf an dieser Stelle legte den
    // gesamten Entscheidungslauf lahm; leer ist die pessimistische und damit
    // richtige Annahme.
    const fleet = summarizeFleet(toStatusReports([zeile({ capabilities: "kaputt" })]));
    expect(fleet.anyMarketDataUsable).toBe(false);
  });

  it("uebernimmt die Frische unveraendert, auch als null", () => {
    // `null` heisst hier ausdruecklich "noch nie etwas geliefert" und nicht
    // "frisch" — ein ersetzter Wert waere ein erfundener Messwert.
    const [report] = toStatusReports([zeile({ dataFreshnessSeconds: null })]);
    expect(report?.dataFreshnessSeconds).toBeNull();
  });
});
