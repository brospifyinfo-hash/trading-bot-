import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";
import { schema, type Database } from "@sae/db";
import { desc, eq } from "drizzle-orm";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import { snapshotSupportsEntry } from "@sae/pipeline";

import { buildMarketAdapters } from "../market-adapters";
import { refreshMarketData } from "../market-refresh";
import { QUOTE_ANCHOR_MINT } from "../quote-market-source";

/**
 * Die Gegenprobe zu `freshness-honesty.test.ts`.
 *
 * Dort wird festgenagelt, dass eine Quelle OHNE Zeitstempel als unbekannt
 * gefuehrt wird und der Torwaechter greift. Hier steht der andere Fall, den es
 * bis zum 2026-09-10 in diesem System ueberhaupt nicht gab: eine Quelle MIT
 * Zeitstempel, ein Snapshot mit echtem Alter, und ein Torwaechter, der zum
 * ersten Mal aufmacht.
 *
 * Der ganze Weg laeuft hier durch — Kettenaufbau, Anbieterauswahl, Quote,
 * Slot, Uhrzeit, Preis, Alter, Snapshot, Datenbank. Nur das Netz ist Papier.
 */

const T0 = new Date("2026-09-10T12:00:00Z");
/** Der Slot wurde 8 Sekunden vor unserem Abruf gerechnet. */
const SLOT_SECONDS = Math.floor(T0.getTime() / 1_000) - 8;
const clock: Clock = { now: () => T0 };
const logger = createLogger({ service: "test", level: "error" });

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const SLOT = 301_234_567;

const ENV = {
  DEXSCREENER_BASE_URL: "https://dexscreener.invalid",
  JUPITER_BASE_URL: "https://jupiter.invalid",
  SOLANA_RPC_URL: "https://rpc.invalid",
} as NodeJS.ProcessEnv;

/** DexScreener liefert die Begleitfelder — und weiterhin keinen Zeitstempel. */
const DEXSCREENER = JSON.stringify([
  {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL,
    baseToken: { address: MEME, symbol: "MEME" },
    quoteToken: { address: QUOTE_ANCHOR_MINT, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 } },
    volume: { h24: 95_000 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    marketCap: 2_100_000,
    pairCreatedAt: T0.getTime() - 6 * 60 * 60 * 1_000,
  },
]);

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

/** 100 USDC -> 250 Mio Token bei 6 Stellen: 0,0004 USD je Token. */
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

let db: Database;
let close: () => Promise<void>;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Ein Netz aus Papier, das nach Adresse und RPC-Methode auseinanderhaelt. */
function netzFuer(fuerMint: string): void {
  const quote = QUOTE.replace(new RegExp(MEME, "g"), fuerMint);
  const dexscreener = DEXSCREENER.replace(new RegExp(MEME, "g"), fuerMint);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const antwort = (body: string): Response =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

    if (href.startsWith("https://jupiter.invalid")) return antwort(quote);
    if (href.startsWith("https://dexscreener.invalid")) return antwort(dexscreener);

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "getBlockTime") {
      return antwort(JSON.stringify({ id: 1, jsonrpc: "2.0", result: SLOT_SECONDS }));
    }
    return antwort(mintAntwort(6));
  }) as typeof fetch;
}

function netz(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

    const antwort = (body: string): Response =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response;

    if (href.startsWith("https://jupiter.invalid")) return antwort(QUOTE);
    if (href.startsWith("https://dexscreener.invalid")) return antwort(DEXSCREENER);

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "getBlockTime") {
      return antwort(JSON.stringify({ id: 1, jsonrpc: "2.0", result: SLOT_SECONDS }));
    }
    return antwort(mintAntwort(6));
  }) as typeof fetch;
}

describe("Frische einer Quelle MIT Zeitstempel", () => {
  it("schreibt ein echtes Alter und nennt die Quelle, die es liefern konnte", async () => {
    await db
      .insert(schema.tokens)
      .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" });
    netz();

    const result = await refreshMarketData("test:quote-freshness", {
      db,
      logger,
      env: ENV,
      clock,
      adapters: buildMarketAdapters({ env: ENV, clock }),
      // Beide Quellen erreichbar — die Kette entscheidet nach Reihenfolge,
      // und jupiter-quote steht vorn.
      statusOf: () => "CONNECTED",
      maxUnitsPerRun: 5,
      maxTokens: 5,
    });

    expect(result.status).toBe("OK");
    expect(result.ingested).toBe(1);
    // Die Zahl, die das ganze Projekt beantwortet: der Snapshot ist da UND er
    // koennte etwas tragen. Ohne benannte Prioritaet stuende hier 0 bei
    // ingested 1 — Daten kommen an, sind aber nichts wert.
    expect(result.entryBlocked).toEqual({ FALLBACK_TIER: 1 });
    expect(result.entryReady).toBe(0);

    const [row] = await db
      .select({
        freshness: schema.tokenSnapshots.sourceFreshnessSeconds,
        provider: schema.tokenSnapshots.sourceProviderId,
        tier: schema.tokenSnapshots.sourceTier,
        price: schema.tokenSnapshots.priceUsd,
        liquidity: schema.tokenSnapshots.liquidityUsd,
      })
      .from(schema.tokenSnapshots)
      .limit(1);

    // DIE Zeile. Bis hierher stand hier immer `null` — oder, schlimmer, eine
    // erfundene 0 (DECISIONS §89).
    expect(row?.freshness).toBe(8);
    expect(row?.provider).toBe("jupiter-quote");
    // Ohne MARKET_DATA_PRIORITY landen beide auf FALLBACK — die Reihenfolge
    // entscheidet, nicht die Stufe.
    expect(row?.tier).toBe("FALLBACK");
    // Der Preis stammt aus dem Quote (0,0004), nicht aus DexScreener
    // (0,00042). Die beiden sind absichtlich verschieden.
    expect(Number(row?.price)).toBeCloseTo(0.0004, 9);
    // Die Liquiditaet kommt weiterhin von DexScreener — durchgereicht, nicht
    // erfunden.
    expect(Number(row?.liquidity)).toBe(180_000);
  });

  /**
   * Derselbe Lauf, nur mit benannter Prioritaet — und erst hier ist die Arbeit
   * tatsaechlich fertig.
   *
   * Der Unterschied zwischen diesem Test und dem darueber ist EINE
   * Umgebungsvariable, und er ist der Unterschied zwischen „Daten kommen an"
   * und „Daten sind etwas wert".
   */
  it("traegt mit benannter Prioritaet eine Einstiegsentscheidung", async () => {
    const mint = "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj";
    await db
      .insert(schema.tokens)
      .values({ mint, discoverySource: "dexscreener", state: "SCREENING" });
    netzFuer(mint);

    const env = { ...ENV, MARKET_DATA_PRIORITY: "jupiter-quote,dexscreener" };
    const result = await refreshMarketData("test:quote-priority", {
      db,
      logger,
      env,
      clock,
      adapters: buildMarketAdapters({ env, clock }),
      statusOf: () => "CONNECTED",
      maxUnitsPerRun: 5,
      maxTokens: 5,
    });

    expect(result.ingested).toBe(1);
    // DIE Zahl. Zum ersten Mal ungleich null.
    expect(result.entryReady).toBe(1);
    expect(result.entryBlocked).toEqual({});

    const [row] = await db
      .select({ tier: schema.tokenSnapshots.sourceTier })
      .from(schema.tokenSnapshots)
      .where(eq(schema.tokenSnapshots.sourceProviderId, "jupiter-quote"))
      .orderBy(desc(schema.tokenSnapshots.observedAt))
      .limit(1);
    expect(row?.tier).toBe("PRIMARY");
  });

  it("laesst den Torwaechter zum ersten Mal aufmachen", () => {
    const mitAlter = snapshotSupportsEntry({
      providerId: "jupiter-quote" as never,
      tier: "PRIMARY",
      freshnessSeconds: 8,
      contributors: [],
    });
    expect(mitAlter.allowed).toBe(true);
  });

  /**
   * Das Alter allein reicht NICHT.
   *
   * Ohne `MARKET_DATA_PRIORITY` landet jede Quelle auf FALLBACK, und
   * Fallback-Daten tragen keine Einstiegsentscheidung — unabhaengig davon, wie
   * frisch sie sind. Das ist eine bewusste Vorgabe und kein Versehen: was
   * entscheidungstragend sein darf, wird benannt, nicht erraten.
   *
   * Fuer den Betrieb heisst das eine konkrete Zeile in der Umgebung:
   * `MARKET_DATA_PRIORITY=jupiter-quote,dexscreener`. Dieser Test steht hier,
   * damit die Abhaengigkeit dokumentiert ist und nicht als „der Bot handelt
   * nicht" wieder auftaucht.
   */
  it("reicht ohne benannte Prioritaet trotzdem nicht fuer einen Einstieg", () => {
    const fallback = snapshotSupportsEntry({
      providerId: "jupiter-quote" as never,
      tier: "FALLBACK",
      freshnessSeconds: 8,
      contributors: [],
    });
    expect(fallback.allowed).toBe(false);
    expect(fallback.reason).toContain("Fallback-Daten");
  });
});
