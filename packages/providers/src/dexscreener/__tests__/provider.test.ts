import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Clock } from "@sae/core";

import { zodContract } from "../../contract";
import {
  DexScreenerMarketAdapter,
  DEXSCREENER_BULK_LIMIT,
  type DexScreenerMarket,
} from "../provider";

/**
 * Der DexScreener-Adapter — ohne DexScreener.
 *
 * Geprueft wird ausschliesslich UNSER Code: URL-Aufbau, Buendelung,
 * Zeitueberschreitung, Fehlerklassifikation und vor allem die Verweigerung,
 * aus einer nicht validierten Antwort einen Marktwert zu machen.
 *
 * Der Vertrag, den einige Tests einsetzen, ist ausdruecklich **kein**
 * DexScreener-Schema. Er heisst `FRAMEWORK_TEST_CONTRACT` und existiert nur,
 * um die Rahmenlogik pruefbar zu machen — eine Behauptung ueber das echte
 * Antwortformat waere genau die Erfindung, die dieser Adapter verhindert.
 */

const T0 = new Date("2026-09-01T12:00:00Z");

class FixedClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

/** Frei erfundenes Schema, NUR zum Pruefen der Rahmenlogik. */
const FRAMEWORK_TEST_CONTRACT = zodContract<readonly DexScreenerMarket[]>({
  schema: z.array(
    z.object({
      mint: z.string(),
      priceUsd: z.number(),
      liquidityUsd: z.number().nullable(),
      marketCapUsd: z.number().nullable(),
      volume24hUsd: z.number().nullable(),
      observedAt: z.null(),
      pairCreatedAt: z.null(),
    }),
  ),
  schemaVersion: "FRAMEWORK_TEST_CONTRACT",
  // Ausdruecklich `false`: er stammt aus keiner Primaerquelle.
  verified: false,
});

function respondWith(input: {
  status?: number;
  body?: string;
  throws?: Error;
}): typeof fetch {
  return (async () => {
    if (input.throws !== undefined) throw input.throws;
    const status = input.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => input.body ?? "[]",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const MINT_A = "So11111111111111111111111111111111111111112";
const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Vertrag: ohne geprueftes Schema kein Marktwert", () => {
  it("lehnt eine syntaktisch gueltige Antwort ab, solange der Vertrag fehlt", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      // Standardvertrag = unverifiziert.
      fetchImpl: respondWith({ body: '[{"priceUsd":"0.00042","liquidity":{"usd":180000}}]' }),
    });

    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("SCHEMA_REJECTED");
    if (result.kind !== "SCHEMA_REJECTED") return;
    // Der entscheidende Unterschied: nicht der Anbieter weicht ab, WIR wissen
    // nicht, was richtig waere.
    expect(result.verified).toBe(false);
    expect(result.reason).toContain("Kein geprueftes Response-Schema");
    expect(result.httpStatus).toBe(200);
  });

  it("meldet den Vertrag als unverifiziert", () => {
    const adapter = new DexScreenerMarketAdapter({ clock: new FixedClock(T0) });
    expect(adapter.contractVerified).toBe(false);
    expect(adapter.schemaVersion).toBe("UNVERIFIED");
  });

  it("lehnt auch bei geprueftem Vertrag eine abweichende Antwort ab", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      contract: FRAMEWORK_TEST_CONTRACT,
      fetchImpl: respondWith({ body: '[{"mint":"x"}]' }),
    });

    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("SCHEMA_REJECTED");
    if (result.kind === "SCHEMA_REJECTED") {
      // Hier weicht die Antwort ab, nicht unser Wissen.
      expect(result.verified).toBe(false);
      expect(result.reason).toContain("priceUsd");
    }
  });

  it("lehnt eine Antwort ab, die kein JSON ist", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      contract: FRAMEWORK_TEST_CONTRACT,
      fetchImpl: respondWith({ body: "<html>Wartung</html>" }),
    });
    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("SCHEMA_REJECTED");
  });

  it("liefert nur bei vollstaendig validierter Antwort Werte", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      contract: FRAMEWORK_TEST_CONTRACT,
      fetchImpl: respondWith({
        body: JSON.stringify([
          {
            mint: MINT_A,
            priceUsd: 0.00042,
            liquidityUsd: 180_000,
            marketCapUsd: null,
            volume24hUsd: null,
            observedAt: null,
            pairCreatedAt: null,
          },
        ]),
      }),
    });

    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.markets[0]?.priceUsd).toBe(0.00042);
    // Kein erfundener Beobachtungszeitpunkt.
    expect(result.markets[0]?.observedAt).toBeNull();
  });
});

describe("Fehlerklassifikation", () => {
  const cases: readonly [number, string][] = [
    [403, "BLOCKED"],
    [407, "BLOCKED"],
    [451, "BLOCKED"],
    [429, "RATE_LIMITED"],
    [500, "UNAVAILABLE"],
    [503, "UNAVAILABLE"],
    [400, "BAD_REQUEST"],
    [422, "BAD_REQUEST"],
  ];

  for (const [status, expected] of cases) {
    it(`ordnet HTTP ${String(status)} als ${expected} ein`, async () => {
      const adapter = new DexScreenerMarketAdapter({
        clock: new FixedClock(T0),
        fetchImpl: respondWith({ status, body: "nope" }),
      });
      const result = await adapter.fetchMarkets([MINT_A]);
      expect(result.kind).toBe("FAILED");
      if (result.kind === "FAILED") {
        expect(result.failure).toBe(expected);
        expect(result.httpStatus).toBe(status);
      }
    });
  }

  it("behandelt 404 als Auskunft, nicht als Ausfall", async () => {
    // Der Anbieter kennt die Adresse nicht. Das ist eine Antwort.
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ status: 404 }),
    });
    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("NO_DATA");
  });

  it("ordnet eine Zeitueberschreitung als UNAVAILABLE ein", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ throws: abort }),
    });
    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") expect(result.failure).toBe("UNAVAILABLE");
  });

  it("ordnet einen Verbindungsabbruch als UNAVAILABLE ein", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ throws: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
    });
    const result = await adapter.fetchMarkets([MINT_A]);
    if (result.kind === "FAILED") expect(result.failure).toBe("UNAVAILABLE");
    else throw new Error("Erwartet FAILED");
  });

  it("sendet nicht, wenn das Rate-Limit-Budget erschoepft ist", async () => {
    let called = false;
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      allowRequest: () => false,
      fetchImpl: (async () => {
        called = true;
        return {} as unknown as Response;
      }) as unknown as typeof fetch,
    });

    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") expect(result.failure).toBe("RATE_LIMITED");
    // Nicht gesendet: ein Aufruf gegen ein erschoepftes Budget verbraucht
    // Kontingent, das beim naechsten Bedarf fehlt.
    expect(called).toBe(false);
  });
});

describe("URL und Buendelung", () => {
  const adapter = new DexScreenerMarketAdapter({ clock: new FixedClock(T0) });

  it("baut die URL aus Kette und Adressen", () => {
    expect(adapter.url([MINT_A])).toBe(
      `https://api.dexscreener.com/tokens/v1/solana/${MINT_A}`,
    );
  });

  it("haengt mehrere Adressen komma-getrennt an", () => {
    expect(adapter.url([MINT_A, MINT_B])).toContain(`${MINT_A},${MINT_B}`);
  });

  it("verweigert einen Aufruf ohne Adresse", () => {
    expect(() => adapter.url([])).toThrow(RangeError);
  });

  it("zerlegt eine lange Liste in Buendel", () => {
    const mints = Array.from({ length: 75 }, (_, i) => `mint-${String(i)}`);
    const batches = DexScreenerMarketAdapter.batches(mints);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(DEXSCREENER_BULK_LIMIT);
    expect(batches[2]).toHaveLength(75 - 2 * DEXSCREENER_BULK_LIMIT);
    // Nichts geht verloren.
    expect(batches.flat()).toHaveLength(75);
  });

  it("spart gegenueber Einzelabrufen", () => {
    // Der Grund, warum DexScreener als erster Provider vorgeschlagen wurde.
    const mints = Array.from({ length: 300 }, (_, i) => `mint-${String(i)}`);
    expect(DexScreenerMarketAdapter.batches(mints)).toHaveLength(10);
  });

  it("verweigert eine unsinnige Buendelgroesse", () => {
    expect(() => DexScreenerMarketAdapter.batches([MINT_A], 0)).toThrow(RangeError);
  });
});

describe("Latenzmessung", () => {
  it("misst die vergangene Zeit, nicht eine geschaetzte", async () => {
    const clock = new FixedClock(T0);
    const adapter = new DexScreenerMarketAdapter({
      clock,
      fetchImpl: (async () => {
        clock.advance(250);
        return { ok: true, status: 200, text: async () => "[]" } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    const result = await adapter.fetchMarkets([MINT_A]);
    expect(result.latencyMs).toBe(250);
  });
});
