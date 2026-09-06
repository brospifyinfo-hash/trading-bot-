import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { systemClock, type Clock } from "@sae/core";
import { schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import { snapshotSupportsEntry } from "@sae/pipeline";

import { buildMarketAdapters } from "../market-adapters";
import { resolveMarketInput } from "../market-input";
import { refreshMarketData } from "../market-refresh";

/**
 * Ein Anbieter ohne Zeitstempel darf nicht als taufrisch gelten.
 *
 * Der Fehler, den diese Datei festnagelt, war unsichtbar und wirkte an der
 * gefaehrlichsten Stelle. `market-refresh` berechnete die Frische als
 * Differenz `sourceTimestamp - dataTimestamp`. Im Live-Pfad sind das ZWEI
 * UNSERER EIGENEN UHREN — `dataTimestamp` ist `Sourced.observedAt`, also
 * unsere Kenntniszeit — und beide werden im selben Abruf gesetzt. Ergebnis:
 * ~0 Sekunden, gespeichert als „null Sekunden alt", fuer eine Quelle, deren
 * Messzeitpunkt niemand kennt.
 *
 * Der Torwaechter `snapshotSupportsEntry` war die ganze Zeit richtig gebaut
 * und traegt sogar den Kommentar „Hier 0 anzunehmen hiesse, die Pruefung
 * abzuschaffen und sie gleichzeitig bestanden zu melden." Er bekam nur nie
 * ein `null` zu sehen.
 */

const T0 = new Date("2026-09-06T20:00:00Z");
const clock: Clock = { now: () => T0 };
const logger = createLogger({ service: "test", level: "error" });

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

/** Eine echte DexScreener-Antwortform. Sie traegt KEINEN Beobachtungszeitpunkt. */
const ANTWORT = JSON.stringify([
  {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL,
    baseToken: { address: MEME, symbol: "MEME" },
    quoteToken: { address: USDC, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 } },
    volume: { h24: 95_000 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    marketCap: 2_100_000,
    pairCreatedAt: T0.getTime() - 6 * 60 * 60 * 1_000,
  },
]);

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

function antwortet(body: string): void {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
}

const ENV = { DEXSCREENER_BASE_URL: "https://api.example.invalid" } as NodeJS.ProcessEnv;

describe("Frische einer Quelle ohne Zeitstempel", () => {
  it("meldet UNBEKANNT und nicht null Sekunden", async () => {
    antwortet(ANTWORT);
    const adapters = buildMarketAdapters({ env: ENV, clock });

    const result = await resolveMarketInput(
      {
        kind: "LIVE",
        tokenId: "00000000-0000-4000-8000-000000000001" as never,
        mint: MEME,
        adapters,
        statusOf: () => "CONNECTED",
        env: ENV,
        allowDegraded: false,
      },
      clock,
    );

    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    // Der Kern: unbekannt bleibt unbekannt, quer durch die Schichten.
    expect(result.freshnessSeconds).toBeNull();
  });

  it("laesst den Torwaechter greifen", () => {
    // Mit der alten Berechnung stand hier eine 0, und der Torwaechter meldete
    // „erlaubt" — die Freigabe fuer eine Einstiegsentscheidung auf Daten
    // unbekannten Alters.
    const unbekannt = snapshotSupportsEntry({
      providerId: "dexscreener" as never,
      tier: "PRIMARY",
      freshnessSeconds: null,
      contributors: [],
    });
    expect(unbekannt.allowed).toBe(false);
    expect(unbekannt.reason).toContain("Unbekannt ist nicht frisch");

    const alsFrischBehauptet = snapshotSupportsEntry({
      providerId: "dexscreener" as never,
      tier: "PRIMARY",
      freshnessSeconds: 0,
      contributors: [],
    });
    expect(alsFrischBehauptet.allowed).toBe(true);
  });

  it("schreibt NULL in die Datenbank, nicht 0", async () => {
    await db
      .insert(schema.tokens)
      .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" });
    antwortet(ANTWORT);

    const result = await refreshMarketData("test:freshness", {
      db,
      logger,
      env: ENV,
      clock: systemClock,
      adapters: buildMarketAdapters({ env: ENV, clock: systemClock }),
      statusOf: () => "CONNECTED",
      maxUnitsPerRun: 5,
      maxTokens: 5,
    });

    expect(result.status).toBe("OK");
    expect(result.ingested).toBe(1);

    const [row] = await db
      .select({ freshness: schema.tokenSnapshots.sourceFreshnessSeconds })
      .from(schema.tokenSnapshots)
      .limit(1);
    // Die Zeile, um die es geht. Eine 0 hier waere eine Behauptung ueber die
    // Welt, die niemand geprueft hat.
    expect(row?.freshness).toBeNull();
  });
});
