import { describe, expect, it } from "vitest";

import { computeExcursions, summarizeExcursions, type PricePoint } from "../excursion";

const ENTRY_AT = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));

function path(prices: readonly number[], stepSeconds = 60): PricePoint[] {
  return prices.map((priceUsd, i) => ({
    at: new Date(ENTRY_AT.getTime() + (i + 1) * stepSeconds * 1_000),
    priceUsd,
  }));
}

function run(prices: readonly number[], exitPriceUsd: number | null = null) {
  return computeExcursions({
    entryPriceUsd: 100,
    entryAt: ENTRY_AT,
    path: path(prices),
    exitPriceUsd,
  });
}

describe("Excursions", () => {
  it("misst Hoch und Tief nach dem Einstieg", () => {
    const r = run([110, 150, 90, 120]);
    expect(r.mfe).toBeCloseTo(0.5);
    expect(r.mae).toBeCloseTo(-0.1);
    expect(r.secondsToPeak).toBe(120);
    expect(r.secondsToTrough).toBe(180);
  });

  it("laesst ein Hoch unter dem Einstieg negativ stehen", () => {
    // Ein auf 0 gedeckeltes MFE wuerde behaupten, es haette einen Ausstieg zum
    // Einstandskurs gegeben.
    const r = run([95, 98, 60]);
    expect(r.mfe).toBeCloseTo(-0.02);
    expect(r.exitEfficiency).toBeNull();
  });

  it("trennt den Rueckgang vor dem Hoch von dem danach", () => {
    // Erst -30 %, dann auf +100 %, dann zurueck auf -50 %.
    const r = run([70, 200, 50]);
    expect(r.maeBeforePeak).toBeCloseTo(-0.3);
    expect(r.maeAfterPeak).toBeCloseTo(-0.5);
    // Der Gesamt-MAE waere -0.5 und wuerde den Einstieg fuer den Einbruch
    // danach bestrafen.
    expect(r.mae).toBeCloseTo(-0.5);
  });

  it("gibt einem Einstieg ohne Rueckgang volle Qualitaet", () => {
    const r = run([120, 180, 300]);
    expect(r.entryQuality).toBe(1);
  });

  it("bestraft einen zu fruehen Einstieg, nicht einen zu spaeten Ausstieg", () => {
    const early = run([50, 200]); // erst halbiert, dann verdoppelt
    const clean = run([200, 50]); // sofort verdoppelt, dann eingebrochen

    expect(early.entryQuality!).toBeLessThan(clean.entryQuality!);
    expect(clean.entryQuality).toBe(1);
    // Beide haben dasselbe MFE und denselben MAE — nur die Reihenfolge trennt sie.
    expect(early.mfe).toBeCloseTo(clean.mfe!);
    expect(early.mae).toBeCloseTo(clean.mae!);
  });

  it("misst die Ausstiegseffizienz am Erreichbaren", () => {
    const r = run([120, 300, 150], 150);
    // Erreichbar waren +200 %, realisiert +50 %.
    expect(r.mfe).toBeCloseTo(2);
    expect(r.realizedReturn).toBeCloseTo(0.5);
    expect(r.exitEfficiency).toBeCloseTo(0.25);
  });

  it("liefert bei offener Position keine Effizienz", () => {
    const r = run([120, 300], null);
    expect(r.realizedReturn).toBeNull();
    expect(r.exitEfficiency).toBeNull();
    expect(r.mfe).toBeCloseTo(2);
  });

  it("erfindet ohne Verlauf nichts", () => {
    const r = computeExcursions({
      entryPriceUsd: 100,
      entryAt: ENTRY_AT,
      path: [],
      exitPriceUsd: 150,
    });
    expect(r.mfe).toBeNull();
    expect(r.realizedReturn).toBeNull();
    expect(r.pathPoints).toBe(0);
  });

  it("weist unsortierte Verlaeufe zurueck, statt sie zu sortieren", () => {
    // Stilles Sortieren wuerde einen Fehler in der Zeitreihenabfrage verdecken —
    // und die Reihenfolge entscheidet ueber „vor" und „nach dem Hoch".
    expect(() =>
      computeExcursions({
        entryPriceUsd: 100,
        entryAt: ENTRY_AT,
        path: [
          { at: new Date(ENTRY_AT.getTime() + 120_000), priceUsd: 200 },
          { at: new Date(ENTRY_AT.getTime() + 60_000), priceUsd: 50 },
        ],
        exitPriceUsd: null,
      }),
    ).toThrow(/aufsteigend/);
  });

  it("weist einen Verlauf vor dem Einstieg zurueck", () => {
    expect(() =>
      computeExcursions({
        entryPriceUsd: 100,
        entryAt: ENTRY_AT,
        path: [{ at: new Date(ENTRY_AT.getTime() - 1_000), priceUsd: 120 }],
        exitPriceUsd: null,
      }),
    ).toThrow(/vor dem Einstieg/);
  });
});

describe("Zusammenfassung ueber mehrere Positionen", () => {
  it("nimmt Mediane, damit ein Verzehnfacher nicht alles bestimmt", () => {
    const ordinary = Array.from({ length: 9 }, () => run([110, 120], 115));
    const moonshot = run([100, 5_000], 4_000);
    const summary = summarizeExcursions([...ordinary, moonshot]);

    expect(summary.count).toBe(10);
    // Der Mittelwert des MFE laege bei ueber 4, der Median beschreibt die
    // ueblichen Trades.
    expect(summary.medianMfe!).toBeLessThan(1);
    expect(summary.shareWithUpside).toBe(1);
  });

  it("liefert ohne Verlaeufe keine Kennzahlen", () => {
    const empty = summarizeExcursions([]);
    expect(empty.medianMfe).toBeNull();
    expect(empty.shareWithUpside).toBeNull();
  });
});
