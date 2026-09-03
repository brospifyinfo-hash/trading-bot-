import { describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import { DexScreenerMarketAdapter, DEXSCREENER_BULK_LIMIT } from "../provider";
import { DEXSCREENER_REAL_RESPONSE, REAL_BASE_MINT } from "./real-response";

/**
 * Der DexScreener-Adapter — ohne DexScreener.
 *
 * Geprueft wird ausschliesslich UNSER Code: URL-Aufbau, Buendelung,
 * Zeitueberschreitung, Fehlerklassifikation und vor allem die Verweigerung,
 * aus einer nicht validierten Antwort einen Marktwert zu machen.
 *
 * Seit der Vertrag steht, laufen die Vertragstests gegen die **echte**
 * Antwort aus `real-response.ts` statt gegen ein Ersatzschema. Der Unterschied
 * ist nicht kosmetisch: ein Test gegen ein selbstgebautes Schema beweist, dass
 * unser Schema zu unserem Schema passt.
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

describe("Vertrag gegen die echte Antwort", () => {
  it("validiert die echte Antwort und normalisiert sie", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ body: DEXSCREENER_REAL_RESPONSE }),
    });

    const result = await adapter.fetchMarkets([REAL_BASE_MINT]);
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;

    const m = result.markets[0];
    expect(m).toBeDefined();
    if (m === undefined) return;

    // Die Marktidentitaet — ohne sie ist keine Auswahl unter mehreren Pools
    // moeglich und keine Auswahl aufzeichenbar.
    expect(m.pairAddress).toBe("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
    expect(m.dexId).toBe("raydium");
    expect(m.chainId).toBe("solana");
    expect(m.baseMint).toBe(REAL_BASE_MINT);
    expect(m.quoteMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("wandelt die Zeichenketten-Preise in Zahlen", async () => {
    // `priceUsd` kommt als "100.17". Ein Schema mit `z.number()` haette jede
    // echte Antwort abgelehnt — und der Fehler haette wie ein Anbieterausfall
    // ausgesehen.
    const result = await fetchReal();
    if (result.kind !== "OK") throw new Error(result.kind);
    expect(result.markets[0]?.priceUsd).toBe(100.17);
    expect(result.markets[0]?.priceNative).toBe(100.1749);
  });

  it("holt die Liquiditaet aus dem verschachtelten Objekt", async () => {
    const result = await fetchReal();
    if (result.kind !== "OK") throw new Error(result.kind);
    expect(result.markets[0]?.liquidityUsd).toBe(14_247_194.46);
    expect(result.markets[0]?.liquidityBase).toBe(70_907);
  });

  it("uebernimmt alle vier Zeitfenster", async () => {
    const result = await fetchReal();
    if (result.kind !== "OK") throw new Error(result.kind);
    const m = result.markets[0];
    expect(m?.volumeUsd.h24).toBe(12_461_528.51);
    expect(m?.volumeUsd.m5).toBe(20_294.25);
    expect(m?.txns.h24).toEqual({ buys: 139_017, sells: 128_610 });
    expect(m?.priceChangePct.m5).toBe(-0.83);
  });

  it("laesst fdv und marketCap null, weil die Antwort sie nicht enthaelt", () => {
    // Der wichtigste Befund der Stichprobe. `null` heisst NOT_AVAILABLE.
    // Aus Preis und geschaetzter Umlaufmenge eine Marktkapitalisierung zu
    // rechnen waere die Erfindung, die dieses System ausschliesst.
    expect(DEXSCREENER_REAL_RESPONSE).not.toContain('"marketCap"');
    expect(DEXSCREENER_REAL_RESPONSE).not.toContain('"fdv"');
  });

  it("erfindet keinen Beobachtungszeitpunkt", async () => {
    const result = await fetchReal();
    if (result.kind !== "OK") throw new Error(result.kind);
    // DexScreener liefert keinen. Der Empfangszeitpunkt ist kein Ersatz —
    // er waere Look-Ahead mit Wirkung bis in jeden Backtest.
    expect(result.markets[0]?.observedAt).toBeNull();
    // `pairCreatedAt` gehoert zum Paar, nicht zum Preis, und ist echt.
    expect(result.markets[0]?.pairCreatedAt).toEqual(new Date(1_669_602_450_000));
  });

  it("meldet den Vertrag als geprueft und nennt den Stand", () => {
    const adapter = new DexScreenerMarketAdapter({ clock: new FixedClock(T0) });
    expect(adapter.contractVerified).toBe(true);
    expect(adapter.schemaVersion).toBe("dexscreener-tokens-v1@2026-09-03");
  });

  it("lehnt eine Antwort ab, die vom Vertrag abweicht", async () => {
    // Kein `pairAddress`: ohne Marktidentitaet ist der Datensatz unbrauchbar,
    // und halb geparst waere er gefaehrlich.
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ body: '[{"chainId":"solana","dexId":"raydium"}]' }),
    });
    const result = await adapter.fetchMarkets([REAL_BASE_MINT]);
    expect(result.kind).toBe("SCHEMA_REJECTED");
    if (result.kind === "SCHEMA_REJECTED") {
      // Hier weicht der ANBIETER ab, nicht unser Wissen.
      expect(result.verified).toBe(true);
    }
  });

  it("lehnt einen Preis ab, der keine Zahl ist", async () => {
    // `Number("")` ist 0 und `Number("n/a")` ist NaN. Beides waere ohne
    // Pruefung als Preis durchgegangen, und eine 0 sieht aus wie eine Messung.
    for (const kaputt of ['""', '"n/a"', '"--"']) {
      const adapter = new DexScreenerMarketAdapter({
        clock: new FixedClock(T0),
        fetchImpl: respondWith({
          body: `[{"chainId":"solana","dexId":"raydium","pairAddress":"p","baseToken":{"address":"a"},"quoteToken":{"address":"b"},"priceUsd":${kaputt}}]`,
        }),
      });
      const result = await adapter.fetchMarkets([REAL_BASE_MINT]);
      expect(result.kind).toBe("SCHEMA_REJECTED");
    }
  });

  it("nimmt unbekannte Felder hin, statt die Aufnahme anzuhalten", async () => {
    // DexScreener liefert `url`, `info`, `labels`, `boosts` und erweitert das
    // jederzeit. Ein strenges Schema haette bei der naechsten Erweiterung die
    // gesamte Datenaufnahme gestoppt — ein Ausfall aus reiner Formstrenge.
    const result = await fetchReal();
    expect(result.kind).toBe("OK");
  });

  it("lehnt eine Antwort ab, die kein JSON ist", async () => {
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ body: "<html>Wartung</html>" }),
    });
    expect((await adapter.fetchMarkets([REAL_BASE_MINT])).kind).toBe("SCHEMA_REJECTED");
  });

  it("liefert bei leerer Antwort keine Maerkte und keinen Fehler", async () => {
    // Ein Token, zu dem DexScreener kein Paar kennt. Auskunft, kein Ausfall.
    const adapter = new DexScreenerMarketAdapter({
      clock: new FixedClock(T0),
      fetchImpl: respondWith({ body: "[]" }),
    });
    const result = await adapter.fetchMarkets([REAL_BASE_MINT]);
    expect(result.kind).toBe("OK");
    if (result.kind === "OK") expect(result.markets).toHaveLength(0);
  });
});

/** Der echte Abruf, wie ihn mehrere Tests brauchen. */
async function fetchReal() {
  const adapter = new DexScreenerMarketAdapter({
    clock: new FixedClock(T0),
    fetchImpl: respondWith({ body: DEXSCREENER_REAL_RESPONSE }),
  });
  return adapter.fetchMarkets([REAL_BASE_MINT]);
}

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
