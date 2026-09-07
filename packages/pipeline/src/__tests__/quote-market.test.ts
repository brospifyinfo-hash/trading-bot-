import { describe, expect, it } from "vitest";

import { quoteToMarket, type QuoteMarketInput } from "../quote-market";
import { assessMarketData, marketDataFieldsFrom } from "../market-data-quality";
import { snapshotSupportsEntry } from "../ingestion";

/**
 * Die Naht, an der die letzte Luecke schliesst.
 *
 * Der wichtigste Test dieser Datei ist der letzte: er fuehrt das Ergebnis
 * durch DENSELBEN Torwaechter, der DexScreener-Daten seit jeher ablehnt, und
 * zeigt, dass ein Quote mit Slot-Uhrzeit ihn passiert — ohne dass irgendwo
 * eine Zahl erfunden wurde.
 */

const T0 = new Date("2026-09-07T07:00:00Z");

function input(over: Partial<QuoteMarketInput> = {}): QuoteMarketInput {
  return {
    quote: {
      inAmountRaw: 10_000_000n,
      inDecimals: 9,
      outAmountRaw: 2_134_500n,
      outDecimals: 6,
      contextSlot: 300_000_000,
    },
    slotTime: new Date(T0.getTime() - 4_000),
    receivedAt: T0,
    liquidityUsd: 180_000,
    marketCapUsd: 2_100_000,
    volume24hUsd: 95_000,
    holders: null,
    ...over,
  };
}

describe("Quote wird Marktdatensatz", () => {
  it("liefert Preis, Beobachtungszeitpunkt und Alter", () => {
    const result = quoteToMarket(input());
    expect(result.kind).toBe("MEASURED");
    if (result.kind !== "MEASURED") return;

    // 0,01 SOL -> 2,1345 USDC, also 213,45 USD je SOL.
    expect(result.value.priceUsd).toBeCloseTo(213.45, 6);
    expect(result.ageSeconds).toBe(4);
    // Zurueckgerechnet: der Zeitpunkt, zu dem der Anbieter gerechnet hat.
    expect(result.observedAt).toEqual(new Date(T0.getTime() - 4_000));
  });

  it("uebernimmt ergaenzende Felder und erfindet die fehlenden nicht", () => {
    const result = quoteToMarket(input({ holders: null, volume24hUsd: null }));
    if (result.kind !== "MEASURED") throw new Error("erwartet: MEASURED");
    expect(result.value.liquidityUsd).toBe(180_000);
    // Fehlend bleibt fehlend — kein 0.
    expect(result.value.volume24hUsd).toBeNull();
    expect(result.value.holders).toBeNull();
  });

  it("trennt fehlenden Quote von fehlender Zeitangabe", () => {
    // Das eine heisst: der Token ist nicht handelbar. Das andere: uns fehlt
    // eine Zeitquelle. Sie zu vermengen hiesse, ein Infrastrukturproblem wie
    // eine Aussage ueber den Markt zu behandeln.
    const ohneQuote = quoteToMarket(input({ quote: null }));
    expect(ohneQuote).toMatchObject({ kind: "UNUSABLE", reason: "NO_QUOTE" });

    const ohneSlot = quoteToMarket(
      input({ quote: { ...input().quote!, contextSlot: null } }),
    );
    expect(ohneSlot).toMatchObject({ kind: "UNUSABLE", reason: "NO_CONTEXT_SLOT" });

    const ohneUhrzeit = quoteToMarket(input({ slotTime: null }));
    expect(ohneUhrzeit).toMatchObject({ kind: "UNUSABLE", reason: "NO_SLOT_TIME" });
  });

  it("liefert bei widerspruechlichen Uhren nichts", () => {
    const result = quoteToMarket(input({ slotTime: new Date(T0.getTime() + 9_000) }));
    expect(result).toMatchObject({ kind: "UNUSABLE", reason: "CLOCK_SKEW" });
  });

  it("passiert den Torwaechter, an dem DexScreener scheitert", () => {
    // Der eigentliche Punkt der ganzen Arbeit. Derselbe Torwaechter, dieselbe
    // Pruefung — nur diesmal mit einem Alter, das gemessen und nicht erfunden
    // ist.
    const result = quoteToMarket(input());
    if (result.kind !== "MEASURED") throw new Error("erwartet: MEASURED");

    const mitAlter = snapshotSupportsEntry({
      providerId: "jupiter" as never,
      tier: "PRIMARY",
      freshnessSeconds: result.ageSeconds,
      contributors: [],
    });
    expect(mitAlter.allowed).toBe(true);

    // Zum Vergleich: derselbe Datensatz ohne Alter, also der heutige Zustand.
    const ohneAlter = snapshotSupportsEntry({
      providerId: "dexscreener" as never,
      tier: "PRIMARY",
      freshnessSeconds: null,
      contributors: [],
    });
    expect(ohneAlter.allowed).toBe(false);
    expect(ohneAlter.reason).toContain("Unbekannt ist nicht frisch");

    // Und die inhaltliche Pruefung sagt ebenfalls zu.
    const verdict = assessMarketData({
      fields: marketDataFieldsFrom(result.value),
      tier: "PRIMARY",
      freshnessSeconds: result.ageSeconds,
    });
    expect(verdict.kind).toBe("PASS");
  });

  it("faellt bei zu altem Quote wieder heraus", () => {
    // Die Frischegrenze bleibt, was sie war. Ein gemessenes Alter heisst
    // „bekannt", nicht „erlaubt".
    const result = quoteToMarket(input({ slotTime: new Date(T0.getTime() - 900_000) }));
    if (result.kind !== "MEASURED") throw new Error("erwartet: MEASURED");
    expect(
      snapshotSupportsEntry({
        providerId: "jupiter" as never,
        tier: "PRIMARY",
        freshnessSeconds: result.ageSeconds,
        contributors: [],
      }).allowed,
    ).toBe(false);
  });
});
