import { describe, expect, it } from "vitest";

import {
  ageToFreshnessSeconds,
  quoteAge,
  quoteUnitPrice,
  type QuoteMeasurement,
} from "../quote-measurement";

/**
 * Der Rechenkern des Weges zur Einstiegsentscheidung.
 *
 * Hier wohnen die gefaehrlichen Fehler: eine vertauschte Dezimalstelle
 * verschiebt einen Preis um Zehnerpotenzen und sieht dabei voellig plausibel
 * aus. Deshalb wird gegen von Hand nachgerechnete Werte geprueft und nicht
 * gegen das, was der Code gerade tut.
 */

const T0 = new Date("2026-09-07T06:00:00Z");

function measurement(over: Partial<QuoteMeasurement> = {}): QuoteMeasurement {
  return {
    // 1 SOL (9 Dezimalstellen) hinein
    inAmountRaw: 1_000_000_000n,
    inDecimals: 9,
    // 213,45 USDC (6 Dezimalstellen) heraus
    outAmountRaw: 213_450_000n,
    outDecimals: 6,
    ...over,
  };
}

describe("Preis aus einem Quote", () => {
  it("rechnet ueber verschiedene Dezimalstellen hinweg richtig", () => {
    // 1 SOL -> 213,45 USDC. Von Hand: 213.45.
    expect(quoteUnitPrice(measurement())).toBeCloseTo(213.45, 6);
  });

  it("trifft auch sehr kleine Preise", () => {
    // Der Memecoin-Fall: 1.000.000 Token (6 Stellen) -> 4,20 USDC.
    // Von Hand: 4.20 / 1_000_000 = 0.0000042
    const preis = quoteUnitPrice(
      measurement({
        inAmountRaw: 1_000_000_000_000n,
        inDecimals: 6,
        outAmountRaw: 4_200_000n,
        outDecimals: 6,
      }),
    );
    expect(preis).toBeCloseTo(0.0000042, 12);
  });

  it("verliert bei gleichen Dezimalstellen nichts", () => {
    expect(
      quoteUnitPrice({
        inAmountRaw: 2_000_000n,
        inDecimals: 6,
        outAmountRaw: 5_000_000n,
        outDecimals: 6,
      }),
    ).toBeCloseTo(2.5, 9);
  });

  it("meldet unbekannt statt null bei leerer Eingabe", () => {
    // Ein Quote ueber nichts ist kein Preis von 0 — es ist kein Preis.
    expect(quoteUnitPrice(measurement({ inAmountRaw: 0n }))).toBeNull();
    expect(quoteUnitPrice(measurement({ outAmountRaw: 0n }))).toBeNull();
  });

  it("verwirft unsinnige Dezimalstellen", () => {
    // Eine geratene oder beschaedigte Dezimalstelle waere ein Betragsfehler um
    // Zehnerpotenzen — lieber gar kein Preis.
    expect(quoteUnitPrice(measurement({ inDecimals: -1 }))).toBeNull();
    expect(quoteUnitPrice(measurement({ outDecimals: 999 }))).toBeNull();
    expect(quoteUnitPrice(measurement({ inDecimals: 1.5 }))).toBeNull();
  });

  it("kommt mit Betraegen jenseits von 2^53 klar", () => {
    // u64 passt nicht in eine JavaScript-Zahl. Die Rechnung laeuft deshalb
    // ganzzahlig bis zur letzten Division.
    const gross = quoteUnitPrice({
      inAmountRaw: 18_000_000_000_000_000_000n,
      inDecimals: 9,
      outAmountRaw: 9_000_000_000_000_000_000n,
      outDecimals: 9,
    });
    expect(gross).toBeCloseTo(0.5, 9);
  });
});

describe("Alter einer Messung", () => {
  it("rechnet das Alter aus der Slot-Uhrzeit", () => {
    const age = quoteAge({
      contextSlot: 300_000_000,
      slotTime: new Date(T0.getTime() - 3_000),
      receivedAt: T0,
    });
    expect(age).toEqual({ kind: "KNOWN", seconds: 3 });
    expect(ageToFreshnessSeconds(age)).toBe(3);
  });

  it("meldet einen fehlenden Slot als eigenen Fall", () => {
    // Genau die Frage, an der der Weg haengt: liefert der Anbieter einen
    // contextSlot? Ohne ihn gibt es kein Alter — und keinen Ersatz dafuer.
    const age = quoteAge({ contextSlot: null, slotTime: T0, receivedAt: T0 });
    expect(age.kind).toBe("NO_CONTEXT_SLOT");
    expect(ageToFreshnessSeconds(age)).toBeNull();
  });

  it("unterscheidet fehlenden Slot von fehlender Uhrzeit", () => {
    // Zwei verschiedene Probleme: das eine loest ein anderer Anbieter, das
    // andere ein erreichbares RPC.
    const age = quoteAge({ contextSlot: 300_000_000, slotTime: null, receivedAt: T0 });
    expect(age.kind).toBe("NO_SLOT_TIME");
    expect(ageToFreshnessSeconds(age)).toBeNull();
  });

  it("kappt eine Messung aus der Zukunft NICHT auf null", () => {
    // Gekappt saehe eine falsch gehende Uhr wie „taufrisch" aus — also wie
    // das beste denkbare Ergebnis. Der Fall bekommt deshalb einen eigenen
    // Namen und faellt aus der Frischepruefung heraus.
    const age = quoteAge({
      contextSlot: 300_000_000,
      slotTime: new Date(T0.getTime() + 5_000),
      receivedAt: T0,
    });
    expect(age).toEqual({ kind: "CLOCK_SKEW", seconds: -5 });
    expect(ageToFreshnessSeconds(age)).toBeNull();
  });
});
