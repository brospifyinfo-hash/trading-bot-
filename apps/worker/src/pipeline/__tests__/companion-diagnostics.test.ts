import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import { buildMarketAdapters, createRejectionTally } from "../market-adapters";
import { QUOTE_ANCHOR_MINT } from "../quote-market-source";

/**
 * Der blinde Fleck zwischen Kurs und Pflichtfeldern.
 *
 * Seit die Kette `jupiter-quote` vorn fuehrt, kommt der Preis vom Router und
 * kommen Liquiditaet, Marktkapitalisierung und 24h-Volumen aus einem
 * Begleitabruf bei DexScreener. Diese drei sind Pflichtfelder am Einstiegstor
 * (`REQUIRED_FOR_ENTRY`): fehlt eines, schliesst das Tor mit
 * `DATA_QUALITY_TOO_LOW`.
 *
 * Im Betrieb stand genau das im Log — und sonst nichts. Der Begleitabruf
 * meldete seinen Ausgang nirgends: seine Ablehnungsgruende wurden bewusst
 * verworfen, damit `tokens` nicht doppelt zaehlt. Damit war „alle drei
 * Pflichtfelder fehlen" eine Beobachtung ohne Ursache, und die Frage „warum
 * kauft er nicht" am Log nicht beantwortbar.
 *
 * Geprueft wird deshalb nicht, dass ein Einstieg entsteht — er entsteht hier
 * zu Recht nicht. Geprueft wird, dass der Grund AUFGESCHRIEBEN wird.
 */

const T0 = new Date("2026-10-01T12:00:00Z");
const SLOT_SECONDS = Math.floor(T0.getTime() / 1_000) - 8;
const clock: Clock = { now: () => T0 };

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const SLOT = 301_234_567;

const ENV = {
  DEXSCREENER_BASE_URL: "https://dexscreener.invalid",
  JUPITER_BASE_URL: "https://jupiter.invalid",
  SOLANA_RPC_URL: "https://rpc.invalid",
} as NodeJS.ProcessEnv;

/** Ein vollstaendiger Begleitdatensatz — alle drei Pflichtfelder besetzt. */
const DEXSCREENER_VOLL = JSON.stringify([
  {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL,
    baseToken: { address: MEME, symbol: "MEME" },
    quoteToken: { address: QUOTE_ANCHOR_MINT, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 }, m5: { buys: 30, sells: 22 } },
    volume: { h24: 95_000, m5: 400 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    marketCap: 2_100_000,
    pairCreatedAt: T0.getTime() - 6 * 60 * 60 * 1_000,
  },
]);

/** Derselbe Pool, aber ohne Marktkapitalisierung. Fehlend, nicht null. */
const DEXSCREENER_OHNE_MCAP = DEXSCREENER_VOLL.replace(',"marketCap":2100000', "");

const QUOTE = JSON.stringify({
  inputMint: QUOTE_ANCHOR_MINT,
  inAmount: "100000000",
  outputMint: MEME,
  outAmount: "250000000000",
  otherAmountThreshold: "249000000000",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0.0012",
  routePlan: [
    {
      swapInfo: {
        ammKey: POOL,
        label: "Raydium",
        inputMint: QUOTE_ANCHOR_MINT,
        outputMint: MEME,
        inAmount: "100000000",
        outAmount: "250000000000",
      },
      percent: 100,
      bps: null,
    },
  ],
  contextSlot: SLOT,
});

function mintAntwort(decimals: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      context: { slot: SLOT },
      value: {
        data: {
          program: "spl-token",
          parsed: {
            type: "mint",
            info: {
              decimals,
              supply: "1000000000000000",
              isInitialized: true,
              mintAuthority: null,
              freezeAuthority: null,
            },
          },
        },
        executable: false,
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
    },
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Netz aus Papier: der Router antwortet immer, DexScreener nach Vorgabe. */
function netz(dexscreener: string): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const antwort = (body: string): Response =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

    if (href.startsWith("https://jupiter.invalid")) return antwort(QUOTE);
    if (href.startsWith("https://dexscreener.invalid")) return antwort(dexscreener);

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "getBlockTime") {
      return antwort(JSON.stringify({ id: 1, jsonrpc: "2.0", result: SLOT_SECONDS }));
    }
    return antwort(mintAntwort(6));
  }) as typeof fetch;
}

/** Wie `netz`, aber DexScreener antwortet mit einem HTTP-Fehler. */
function netzMitStatus(status: number): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const antwort = (body: string, code = 200): Response =>
      ({ ok: code >= 200 && code < 300, status: code, text: async () => body }) as unknown as Response;

    if (href.startsWith("https://jupiter.invalid")) return antwort(QUOTE);
    if (href.startsWith("https://dexscreener.invalid")) return antwort("rate limited", status);

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "getBlockTime") {
      return antwort(JSON.stringify({ id: 1, jsonrpc: "2.0", result: SLOT_SECONDS }));
    }
    return antwort(mintAntwort(6));
  }) as typeof fetch;
}

async function begleitdaten(dexscreener: string): Promise<{
  readonly companion: Readonly<Record<string, number>>;
  readonly liquidityUsd: number | null;
  readonly marketCapUsd: number | null;
}> {
  netz(dexscreener);
  const rejections = createRejectionTally();
  const adapter = buildMarketAdapters({ env: ENV, clock, rejections }).get("jupiter-quote");
  if (adapter === undefined) throw new Error("jupiter-quote adapter fehlt");
  const out = await adapter.fetchMarket(MEME);
  return {
    companion: rejections.drain().companion,
    liquidityUsd: out?.value.liquidityUsd ?? null,
    marketCapUsd: out?.value.marketCapUsd ?? null,
  };
}

describe("Begleitabruf", () => {
  it("meldet OK, wenn alle drei Pflichtfelder da sind", async () => {
    const out = await begleitdaten(DEXSCREENER_VOLL);
    expect(out.liquidityUsd).toBe(180_000);
    expect(out.marketCapUsd).toBe(2_100_000);
    expect(out.companion).toEqual({ OK: 1 });
  });

  it("nennt das Feld, das fehlt — nicht nur dass etwas fehlt", async () => {
    const out = await begleitdaten(DEXSCREENER_OHNE_MCAP);
    // Der Kurs steht, die Liquiditaet steht, nur die Marktkapitalisierung
    // fehlt. Das ist der Unterschied zwischen „Quelle tot" und „ein Feld
    // fehlt", und er entscheidet, was man dagegen tut.
    expect(out.liquidityUsd).toBe(180_000);
    expect(out.marketCapUsd).toBeNull();
    expect(out.companion).toEqual({ marketCapUsd: 1 });
  });

  it("nennt KEIN_MARKT, wenn der Begleitabruf gar keinen Pool hergibt", async () => {
    const out = await begleitdaten("[]");
    // Genau die Lage aus dem Betrieb: ein Kurs ohne Begleitfelder. Vorher
    // sah man davon nur das Ergebnis am Ende der Kette.
    expect(out.liquidityUsd).toBeNull();
    expect(out.marketCapUsd).toBeNull();
    expect(out.companion["KEIN_MARKT"]).toBe(1);
  });

  it("unterscheidet Drosselung von einem Token ohne Pool", async () => {
    // Beides endete vorher als dasselbe `null`. Die Gegenmassnahme ist je
    // Fall eine andere — Takt senken gegen Drosselung, Token abschreiben bei
    // NO_DATA —, und genau das war am Log nicht ablesbar.
    netzMitStatus(429);
    const rejections = createRejectionTally();
    const adapter = buildMarketAdapters({ env: ENV, clock, rejections }).get("jupiter-quote");
    if (adapter === undefined) throw new Error("jupiter-quote adapter fehlt");
    await adapter.fetchMarket(MEME);
    const companion = rejections.drain().companion;
    expect(companion["DS_RATE_LIMITED"]).toBe(1);
    expect(companion["KEIN_MARKT"]).toBe(1);
  });

  it("nennt den Ausschlussgrund, wenn ein Pool die Auswahl nicht besteht", async () => {
    const duenn = DEXSCREENER_VOLL.replace('"liquidity":{"usd":180000', '"liquidity":{"usd":100');
    const out = await begleitdaten(duenn);
    expect(out.liquidityUsd).toBeNull();
    // Der Grund kommt aus `selectMarket` und landet im Begleitkanal, nicht in
    // `record` — sonst zaehlte der Token als quellenlos, obwohl der Router
    // geantwortet hat.
    // `LIQUIDITY_TOO_LO` ist `LIQUIDITY_TOO_LOW`, auf 16 Zeichen gekuerzt —
    // `safeLabel` deckelt jedes Etikett, das aus einer Anbieterantwort
    // stammen koennte. Hier steht der gekuerzte Schluessel ausgeschrieben,
    // damit niemand den Deckel spaeter fuer einen Tippfehler haelt.
    expect(out.companion["LIQUIDITY_TOO_LO"]).toBe(1);
    expect(out.companion["KEIN_MARKT"]).toBe(1);
  });
});
