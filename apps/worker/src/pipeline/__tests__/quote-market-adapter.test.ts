import { describe, expect, it } from "vitest";
import { sourced } from "@sae/providers";
import { snapshotSupportsEntry } from "@sae/pipeline";
import type { Clock } from "@sae/core";

import { quoteMarketAdapter, QUOTE_PROVIDER_ID, type QuoteMarketDeps } from "../quote-market-adapter";

/**
 * Der Anbieter, der einen Preis MIT Zeitstempel liefert.
 *
 * Geprueft wird der ganze Weg ohne Netz: Quote, Slot, Uhrzeit, Preis, Alter,
 * und am Ende derselbe Torwaechter, der DexScreener-Daten ablehnt. Die Abrufe
 * sind eingespeist — was hier geprueft wird, ist unsere Rechnung und unsere
 * Verkettung, nicht das Verhalten eines Anbieters.
 */

const T0 = new Date("2026-09-07T12:00:00Z");
const clock: Clock = { now: () => T0 };
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function deps(over: Partial<QuoteMarketDeps> = {}): QuoteMarketDeps {
  return {
    clock,
    quoteMint: USDC,
    quoteDecimals: 6,
    probeAmountRaw: 1_000_000n,
    decimalsOf: async () => 6,
    fetchQuote: async () => ({ outAmountRaw: 4_200_000n, contextSlot: 300_000_000 }),
    fetchSlotTime: async () => new Date(T0.getTime() - 2_000),
    ...over,
  };
}

describe("Preis mit Zeitstempel", () => {
  it("fuellt observedAt mit der Zeit des ANBIETERS", async () => {
    const result = await quoteMarketAdapter(deps()).fetchMarket(MEME);
    expect(result).not.toBeNull();
    if (result === null) return;

    // 1 Token (6 Stellen) -> 4,20 USDC. Von Hand: 4.20.
    expect(result.value.priceUsd).toBeCloseTo(4.2, 9);
    // Nicht unsere Abrufzeit, sondern die Rechenzeit des Anbieters.
    expect(result.observedAt).toEqual(new Date(T0.getTime() - 2_000));
  });

  it("ergibt ueber sourced() ein echtes Datenalter", async () => {
    // Der Punkt der ganzen Kette: hier entsteht die Zahl, die bisher immer
    // `null` war und einmal faelschlich 0 (DECISIONS §89).
    const result = await quoteMarketAdapter(deps()).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");

    const s = sourced({
      value: result.value,
      providerId: QUOTE_PROVIDER_ID,
      tier: "PRIMARY",
      providerObservedAt: result.observedAt,
      fetchedAt: T0,
    });
    expect(s.freshnessSeconds).toBe(2);

    expect(
      snapshotSupportsEntry({
        providerId: QUOTE_PROVIDER_ID,
        tier: "PRIMARY",
        freshnessSeconds: s.freshnessSeconds,
        contributors: [],
      }).allowed,
    ).toBe(true);
  });

  it("liefert nichts ohne Dezimalstellen", async () => {
    // Geratene Dezimalstellen waeren ein Betragsfehler um Zehnerpotenzen —
    // der teuerste denkbare Fehler in dieser Rechnung.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({ decimalsOf: async () => null, onUnusable: (_m, r) => gruende.push(r) }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_DECIMALS"]);
  });

  it("liefert nichts, wenn der Anbieter keinen Slot nennt", async () => {
    // Genau der Fall, an dem der ganze Weg haengt. Ohne Slot kein Alter — und
    // ohne Alter wird hier nichts erfunden.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ outAmountRaw: 4_200_000n, contextSlot: null }),
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_CONTEXT_SLOT"]);
  });

  it("fragt die Slot-Uhrzeit gar nicht erst ohne Slot", async () => {
    let gefragt = 0;
    await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ outAmountRaw: 4_200_000n, contextSlot: null }),
        fetchSlotTime: async () => {
          gefragt += 1;
          return T0;
        },
      }),
    ).fetchMarket(MEME);
    // Ein Aufruf, dessen Ergebnis feststeht, kostet nur Budget.
    expect(gefragt).toBe(0);
  });

  it("reicht ergaenzende Felder durch und erfindet die fehlenden nicht", async () => {
    const result = await quoteMarketAdapter(
      deps({ companion: async () => ({ liquidityUsd: 180_000 }) }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.liquidityUsd).toBe(180_000);
    expect(result.value.volume24hUsd).toBeNull();
    expect(result.value.holders).toBeNull();
  });

  it("liefert nichts, wenn der Router keinen Weg findet", async () => {
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({ fetchQuote: async () => null, onUnusable: (_m, r) => gruende.push(r) }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_QUOTE"]);
  });
});
