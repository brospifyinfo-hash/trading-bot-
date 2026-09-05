import { describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import { buildMarketAdapters, USD_ANCHOR_QUOTE_MINTS } from "../market-adapters";

/**
 * Die Brücke vom Anbieter in die Kette.
 *
 * Zwei Zusicherungen tragen diese Datei, und beide betreffen Fehler, die im
 * Betrieb unsichtbar waeren:
 *
 * 1. Bei mehreren Pools wird **nicht der erste** genommen.
 * 2. Es entsteht **kein** Beobachtungszeitpunkt, den der Anbieter nicht
 *    geliefert hat.
 */

const T0 = new Date("2026-09-05T12:00:00Z");
const fixedClock: Clock = { now: () => T0 };

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_DUENN = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const POOL_TIEF = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

/** Alt genug fuer die Pool-Altersgrenze. */
const ALT = T0.getTime() - 6 * 60 * 60 * 1_000;

function pair(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL_TIEF,
    baseToken: { address: MEME, symbol: "MEME" },
    quoteToken: { address: USDC, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 } },
    volume: { h24: 95_000 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    pairCreatedAt: ALT,
    ...over,
  };
}

/** Ein Adapter, dessen fetch eine vorgegebene Antwort liefert. */
function adapterWith(body: string, status = 200) {
  const fetchImpl = (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

  // Der Adapter wird ueber die Abbildung gebaut; fuer den Test wird der
  // fetch-Aufruf im inneren Adapter ersetzt. Dafuer reicht der oeffentliche
  // Weg nicht aus, deshalb hier die Abbildung mit eigener Basis-URL und ein
  // ueberschriebenes globales fetch.
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const adapters = buildMarketAdapters({
    env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
    clock: fixedClock,
  });
  return {
    adapter: adapters.get("dexscreener")!,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function fetchMarket(body: string, status = 200) {
  const { adapter, restore } = adapterWith(body, status);
  try {
    return await adapter.fetchMarket(MEME);
  } finally {
    restore();
  }
}

describe("Vom Anbieter in die Kette", () => {
  it("liefert den gewaehlten Markt als Kettenwert", async () => {
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out).not.toBeNull();
    expect(out?.value.priceUsd).toBe(0.00042);
    expect(out?.value.liquidityUsd).toBe(180_000);
    expect(out?.value.volume24hUsd).toBe(95_000);
  });

  it("nimmt bei mehreren Pools NICHT den ersten", async () => {
    // Der duenne Pool steht vorn in der Antwort. Genau die Falle.
    const body = JSON.stringify([
      pair({ pairAddress: POOL_DUENN, liquidity: { usd: 9_000 }, priceUsd: "0.00099" }),
      pair({ pairAddress: POOL_TIEF, liquidity: { usd: 400_000 }, priceUsd: "0.00042" }),
    ]);
    const out = await fetchMarket(body);
    expect(out?.value.liquidityUsd).toBe(400_000);
    expect(out?.value.priceUsd).toBe(0.00042);
  });

  it("erfindet keinen Beobachtungszeitpunkt", async () => {
    // DexScreener liefert keinen. Der Abrufzeitpunkt ist kein Ersatz — er
    // waere eine behauptete Frische und truege bis in jeden Backtest.
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out?.observedAt).toBeNull();
  });

  it("laesst marketCap null, wenn der Anbieter es nicht liefert", async () => {
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out?.value.marketCapUsd).toBeNull();
  });

  it("reicht marketCap durch, wenn es geliefert wird", async () => {
    const out = await fetchMarket(JSON.stringify([pair({ marketCap: 2_400_000 })]));
    expect(out?.value.marketCapUsd).toBe(2_400_000);
  });
});

describe("Was nicht durchkommt", () => {
  it("liefert nichts, wenn kein Pool die Pruefung besteht", async () => {
    // Zu wenig Liquiditaet.
    const out = await fetchMarket(JSON.stringify([pair({ liquidity: { usd: 100 } })]));
    expect(out).toBeNull();
  });

  it("liefert nichts bei einem Quote-Asset ohne USD-Anker", async () => {
    const out = await fetchMarket(
      JSON.stringify([pair({ quoteToken: { address: MEME, symbol: "MEME" } })]),
    );
    expect(out).toBeNull();
  });

  it("verwirft Pools mit unbrauchbarer Adresse", async () => {
    // Keine Base58-Adresse. Kommt so etwas an, ist es ein Anbieterfehler oder
    // etwas Schlimmeres — in beiden Faellen keine Grundlage.
    const out = await fetchMarket(JSON.stringify([pair({ pairAddress: "nicht base58!!" })]));
    expect(out).toBeNull();
  });

  it("liefert nichts bei einer Antwort, die nicht zum Vertrag passt", async () => {
    const out = await fetchMarket('[{"chainId":"solana"}]');
    expect(out).toBeNull();
  });

  it("liefert nichts bei HTTP-Fehler", async () => {
    expect(await fetchMarket("nope", 503)).toBeNull();
  });

  it("liefert nichts bei leerer Antwort", async () => {
    expect(await fetchMarket("[]")).toBeNull();
  });

  it("fragt gar nicht erst bei unbrauchbarer Mint-Adresse", async () => {
    const { adapter, restore } = adapterWith(JSON.stringify([pair()]));
    try {
      expect(await adapter.fetchMarket("keine adresse")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Quote-Anker", () => {
  it("fuehrt SOL, USDC und USDT", () => {
    expect(USD_ANCHOR_QUOTE_MINTS).toHaveLength(3);
    expect(USD_ANCHOR_QUOTE_MINTS).toContain(USDC);
  });
});
