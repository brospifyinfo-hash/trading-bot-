import { afterEach, describe, expect, it } from "vitest";
import { isPresent, type Clock } from "@sae/core";

import { dexScreenerProfileDiscovery } from "../discovery-source";

/**
 * Die Quelle, die dem Bot bisher fehlte.
 *
 * Geprueft wird nicht, dass ein Mock funktioniert, sondern die drei Aussagen,
 * die im Betrieb unsichtbar falsch sein koennten:
 *
 * 1. Es sind ZWEI Aufrufe, und der zweite traegt die Marktdaten. Eine Quelle,
 *    die nur den ersten kennt, meldet Werbetexte.
 * 2. Ein Ausfall ist kein leeres Ergebnis.
 * 3. Eine unbekannte Liquiditaet ist nicht null — auch nicht beim Vergleich
 *    zweier Pools.
 */

const T0 = new Date("2026-09-06T09:00:00Z");
const clock: Clock = { now: () => T0 };
const BASE = "https://api.example.invalid";

const MEME_A = "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump";
const MEME_B = "GSBZLSX8R8nq9qp2fs5oaLcQS72aG1SFEyuqbS1Apump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_DUENN = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const POOL_TIEF = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

interface Route {
  readonly body: string;
  readonly status?: number;
}

/** Beantwortet die beiden Pfade getrennt und zaehlt die Aufrufe. */
function route(profiles: Route, markets: Route): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const r = url.includes("/token-profiles/") ? profiles : markets;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

function profileBody(mints: readonly string[]): string {
  return JSON.stringify(
    mints.map((mint) => ({
      chainId: "solana",
      tokenAddress: mint,
      description: "",
      cto: false,
    })),
  );
}

function pair(over: Record<string, unknown>): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL_TIEF,
    baseToken: { address: MEME_A, symbol: "MEMEA" },
    quoteToken: { address: USDC, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 } },
    volume: { h24: 95_000 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    pairCreatedAt: T0.getTime() - 6 * 60 * 60 * 1_000,
    ...over,
  };
}

describe("Discovery-Quelle DexScreener", () => {
  it("fragt zuerst die Adressen und dann die Marktdaten", async () => {
    const { calls } = route(
      { body: profileBody([MEME_A]) },
      { body: JSON.stringify([pair({})]) },
    );

    const result = await dexScreenerProfileDiscovery({ clock, baseUrl: BASE }).discover(T0);
    expect(isPresent(result)).toBe(true);
    if (!isPresent(result)) return;

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/token-profiles/latest/v1");
    // Der zweite Aufruf ist der, der die Werte traegt — und er enthaelt genau
    // die Adressen aus dem ersten.
    expect(calls[1]).toContain(`/tokens/v1/solana/${MEME_A}`);

    const [token] = result.value;
    expect(token?.mint).toBe(MEME_A);
    expect(token?.symbol).toBe("MEMEA");
    expect(token?.trigger).toBe("NEW_LAUNCH");
    // Unser Beobachtungszeitpunkt, nicht einer des Anbieters.
    expect(token?.observedAt).toEqual(T0);
    expect(token?.liquidityUsd.kind).toBe("OBSERVED");
  });

  it("meldet einen Ausfall des Adressstroms als Missing mit Grund", async () => {
    route({ body: "", status: 429 }, { body: "[]" });

    const result = await dexScreenerProfileDiscovery({ clock, baseUrl: BASE }).discover(T0);
    expect(isPresent(result)).toBe(false);
    if (isPresent(result)) return;
    // Gedrosselt ist nicht dasselbe wie tot: der Grund entscheidet spaeter,
    // ob jemand wartet oder sucht.
    expect(result.reason).toBe("PROVIDER_RATE_LIMITED");
  });

  it("liefert die Adressen auch dann, wenn die Marktdaten ausfallen", async () => {
    // Ohne Grobwerte kommt der Token durch und faellt im Vorsieb — besser als
    // den ganzen Durchlauf zu verwerfen.
    route({ body: profileBody([MEME_A]) }, { body: "", status: 503 });

    const result = await dexScreenerProfileDiscovery({ clock, baseUrl: BASE }).discover(T0);
    if (!isPresent(result)) throw new Error("erwartet: Ergebnis");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.liquidityUsd.kind).toBe("MISSING");
    expect(result.value[0]?.marketCapUsd.kind).toBe("MISSING");
    expect(result.value[0]?.symbol).toBeNull();
  });

  it("laesst einen Pool mit unbekannter Liquiditaet nicht gegen null verlieren", async () => {
    // Der Kern der Regel: `(a ?? 0) > (b ?? 0)` haette den Pool ohne Angabe
    // wie einen mit 0 USD behandelt. Hier kommt der bekannte zuerst und der
    // unbekannte danach — der bekannte muss gewinnen, und umgekehrt genauso.
    route(
      { body: profileBody([MEME_A]) },
      {
        body: JSON.stringify([
          pair({ pairAddress: POOL_TIEF, liquidity: { usd: 180_000, base: 1, quote: 2 } }),
          pair({ pairAddress: POOL_DUENN, liquidity: undefined }),
        ]),
      },
    );

    const result = await dexScreenerProfileDiscovery({ clock, baseUrl: BASE }).discover(T0);
    if (!isPresent(result)) throw new Error("erwartet: Ergebnis");

    const [token] = result.value;
    expect(token?.poolAddress).toBe(POOL_TIEF);
    if (token === undefined || !isPresent(token.liquidityUsd)) {
      throw new Error("erwartet: bekannte Liquiditaet");
    }
    expect(token.liquidityUsd.value).toBe(180_000);
  });

  it("buendelt die Anreicherung statt je Adresse einzeln zu fragen", async () => {
    const { calls } = route(
      { body: profileBody([MEME_A, MEME_B]) },
      { body: JSON.stringify([pair({})]) },
    );

    await dexScreenerProfileDiscovery({ clock, baseUrl: BASE, bulkLimit: 30 }).discover(T0);
    // Ein Profil-Aufruf, ein Buendel-Aufruf — nicht drei.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain(`${MEME_A},${MEME_B}`);
  });
});
