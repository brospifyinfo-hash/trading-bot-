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
    // 100 USDC — die Summe, fuer die gefragt wird, auf der ANKER-Seite.
    probeNotional: 100,
    decimalsOf: async () => 6,
    // Dafuer gibt es 25 Token (6 Stellen). Preis von Hand: 100 / 25 = 4,00.
    fetchQuote: async () => ({ outAmountRaw: 25_000_000n, contextSlot: 300_000_000 }),
    fetchSlotTime: async () => new Date(T0.getTime() - 2_000),
    ...over,
  };
}

describe("Preis mit Zeitstempel", () => {
  it("fuellt observedAt mit der Zeit des ANBIETERS", async () => {
    const result = await quoteMarketAdapter(deps()).fetchMarket(MEME);
    expect(result).not.toBeNull();
    if (result === null) return;

    // 100 USDC -> 25 Token. Ein Token kostet also 4,00.
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
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

  /**
   * Der Anker ist nicht lesbar — ein anderer Befund als „dieser Token ist
   * nicht lesbar", weil er JEDEN Token betrifft. Im Log ist der Unterschied
   * die Antwort auf die Frage, ob ein Token oder die Quelle das Problem ist.
   */
  it("unterscheidet einen unlesbaren Anker von einem unlesbaren Token", async () => {
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        decimalsOf: async (m) => (m === USDC ? null : 6),
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_ANCHOR_DECIMALS"]);
  });

  /**
   * Die Probemenge wird aus den GELESENEN Ankerstellen gerechnet, nicht aus
   * einer Konstante. Ein Anker mit neun Stellen muss deshalb auch eine
   * neunstellige Rohmenge ergeben — sonst waere die Anfrage um Faktor 1000 zu
   * klein und der Preis stammte aus einem Staubauftrag.
   */
  it("rechnet die Probemenge aus den gelesenen Ankerstellen", async () => {
    const gefragt: bigint[] = [];
    await quoteMarketAdapter(
      deps({
        decimalsOf: async (m) => (m === USDC ? 9 : 6),
        fetchQuote: async (input) => {
          gefragt.push(input.amountRaw);
          return { outAmountRaw: 25_000_000n, contextSlot: 300_000_000 };
        },
      }),
    ).fetchMarket(MEME);
    expect(gefragt).toEqual([100_000_000_000n]);
  });

  it("fragt gar nicht erst mit einer unsinnigen Probemenge", async () => {
    const gruende: string[] = [];
    let gefragt = 0;
    const result = await quoteMarketAdapter(
      deps({
        probeNotional: 0,
        fetchQuote: async () => {
          gefragt += 1;
          return { outAmountRaw: 25_000_000n, contextSlot: 300_000_000 };
        },
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["BAD_PROBE_SIZE"]);
    expect(gefragt).toBe(0);
  });

  it("liefert nichts, wenn der Anbieter keinen Slot nennt", async () => {
    // Genau der Fall, an dem der ganze Weg haengt. Ohne Slot kein Alter — und
    // ohne Alter wird hier nichts erfunden.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ outAmountRaw: 25_000_000n, contextSlot: null }),
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
        fetchQuote: async () => ({ outAmountRaw: 25_000_000n, contextSlot: null }),
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

  /**
   * Die Richtung ist der Fehler, der stumm bleibt.
   *
   * Ein vertauschtes Paar liefert weiterhin eine Zahl, einen Slot und ein
   * Alter — nur eben den Kehrwert des Preises. Bei einem Token zu 4,00 stuende
   * dann 0,25 im Snapshot, und nichts daran sieht kaputt aus.
   */
  it("fragt mit dem Anker und liest die Messung vom Token aus", async () => {
    const gefragt: { inputMint: string; outputMint: string; amountRaw: bigint }[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async (input) => {
          gefragt.push(input);
          return { outAmountRaw: 25_000_000n, contextSlot: 300_000_000 };
        },
      }),
    ).fetchMarket(MEME);

    expect(gefragt).toEqual([
      { inputMint: USDC, outputMint: MEME, amountRaw: 100_000_000n },
    ]);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
    // Ausdruecklich: NICHT der Kehrwert.
    expect(result.value.priceUsd).not.toBeCloseTo(0.25, 9);
  });

  /**
   * Der Fall, den eine feste Rohmenge auf der Token-Seite falsch gemacht
   * haette: neun Dezimalstellen statt sechs. Die Anker-Seite bleibt davon
   * unberuehrt, und der Preis stimmt weiterhin.
   */
  it("rechnet auch bei neun Dezimalstellen richtig", async () => {
    const result = await quoteMarketAdapter(
      deps({
        // Nur der gesuchte Token hat neun Stellen; der Anker behaelt sechs.
        decimalsOf: async (m) => (m === USDC ? 6 : 9),
        // 100 USDC -> 25 Token, diesmal mit 9 Stellen ausgedrueckt.
        fetchQuote: async () => ({ outAmountRaw: 25_000_000_000n, contextSlot: 300_000_000 }),
      }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
  });

  /**
   * Der eigentliche Anwendungsfall: ein Memecoin unter einem Cent. Genau der
   * Bereich, in dem eine Ganzzahl-Division ohne Zusatzstellen glatt 0 ergaebe.
   */
  it("traegt einen Preis von Bruchteilen eines Cents", async () => {
    const result = await quoteMarketAdapter(
      deps({
        // 100 USDC -> 400 Mio Token: 0,00000025 USD je Token.
        fetchQuote: async () => ({ outAmountRaw: 400_000_000_000_000n, contextSlot: 300_000_000 }),
      }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(0.00000025, 12);
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
