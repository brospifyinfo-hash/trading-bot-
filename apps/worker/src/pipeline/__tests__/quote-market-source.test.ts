import { FixedClock } from "@sae/core";
import { describe, expect, it } from "vitest";

import {
  buildQuoteMarketDeps,
  QUOTE_ANCHOR_MINT,
  QUOTE_PROBE_NOTIONAL,
} from "../quote-market-source";

/**
 * Die Verkabelung zwischen Rechnung und Anbietern.
 *
 * Geprueft wird hier nichts an der Preisformel — die steht in
 * `quote-market-adapter.test.ts`. Hier geht es um die Fehler, die genau an
 * dieser Naht wohnen und im Betrieb wie ein langsamer Anbieter aussehen:
 * ein nicht gemerktes Ergebnis, ein falsch gelesener Betrag, ein Slot ohne
 * Uhrzeit, der trotzdem eine Zahl erzeugt.
 */

const T0 = new Date("2026-09-10T00:00:00Z");
const ENV = {
  JUPITER_BASE_URL: "https://jupiter.invalid",
  SOLANA_RPC_URL: "https://rpc.invalid",
} as const;

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SLOT = 301_234_567;
/** Unix-SEKUNDEN, wie `getBlockTime` sie liefert. */
const SLOT_SECONDS = 1_757_468_000;

/** Die gemessene Antwortform von `getAccountInfo` mit `jsonParsed`. */
function mintResponse(decimals: number): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      context: { apiVersion: "2.1.0", slot: SLOT },
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
          space: 82,
        },
        executable: false,
        lamports: 1_461_600,
        owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        rentEpoch: 18_446_744_073_709_552_000,
      },
    },
  };
}

function quoteResponse(outAmount: string, contextSlot: number | undefined): unknown {
  return {
    inputMint: QUOTE_ANCHOR_MINT,
    inAmount: "100000000",
    outputMint: MEME,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0.0012",
    routePlan: [
      {
        swapInfo: {
          ammKey: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
          label: "Raydium",
          inputMint: QUOTE_ANCHOR_MINT,
          outputMint: MEME,
          inAmount: "100000000",
          outAmount,
        },
        percent: 100,
        bps: null,
      },
    ],
    ...(contextSlot === undefined ? {} : { contextSlot }),
  };
}

interface Aufzeichnung {
  readonly calls: string[];
  readonly rpcMethods: string[];
}

/**
 * Ein Netz aus Papier.
 *
 * Beantwortet die drei Anfragen und schreibt mit, welche tatsaechlich
 * hinausgingen — der einzige Weg, „gemerkt" von „erneut gefragt" zu
 * unterscheiden.
 */
function fakeNet(
  over: {
    decimals?: number;
    outAmount?: string;
    blockTime?: number | null;
    /** So viele Quote-Anfragen antworten zuerst mit HTTP 429. */
    rateLimitFirst?: number;
  } = {},
): {
  readonly fetchImpl: typeof fetch;
  readonly log: Aufzeichnung;
} {
  const log: Aufzeichnung = { calls: [], rpcMethods: [] };
  let abgewiesen = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    log.calls.push(href);

    if (href.startsWith(ENV.JUPITER_BASE_URL)) {
      if (abgewiesen < (over.rateLimitFirst ?? 0)) {
        abgewiesen += 1;
        return new Response("rate limit exceeded", { status: 429 });
      }
      const slot = new URL(href).searchParams.get("kein-slot") === null ? SLOT : undefined;
      return new Response(JSON.stringify(quoteResponse(over.outAmount ?? "25000000", slot)), {
        status: 200,
      });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    log.rpcMethods.push(body.method ?? "?");

    if (body.method === "getBlockTime") {
      const value = over.blockTime === undefined ? SLOT_SECONDS : over.blockTime;
      return new Response(JSON.stringify({ id: 1, jsonrpc: "2.0", result: value }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(mintResponse(over.decimals ?? 6)), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetchImpl, log };
}

describe("buildQuoteMarketDeps", () => {
  it("baut nichts ohne beide Adressen", () => {
    const clock = new FixedClock(T0);
    // Ein halbfertiges Kettenmitglied waere schlimmer als keins: es lieferte
    // bei jedem Token dieselbe Ablehnung und saehe im Dashboard nach einem
    // Anbieterproblem aus.
    expect(buildQuoteMarketDeps({ clock, env: { JUPITER_BASE_URL: ENV.JUPITER_BASE_URL } })).toBeNull();
    expect(buildQuoteMarketDeps({ clock, env: { SOLANA_RPC_URL: ENV.SOLANA_RPC_URL } })).toBeNull();
    expect(buildQuoteMarketDeps({ clock, env: {} })).toBeNull();
    expect(buildQuoteMarketDeps({ clock, env: ENV })).not.toBeNull();
  });

  it("liest die Dezimalstellen vom Knoten und fragt sie danach nicht erneut", async () => {
    const { fetchImpl, log } = fakeNet({ decimals: 9 });
    const deps = buildQuoteMarketDeps({ clock: new FixedClock(T0), env: ENV, fetchImpl })!;

    expect(await deps.decimalsOf(MEME)).toBe(9);
    expect(await deps.decimalsOf(MEME)).toBe(9);
    expect(await deps.decimalsOf(MEME)).toBe(9);
    // Dezimalstellen eines SPL-Mint stehen nach der Erzeugung fest. Sie bei
    // jedem Takt erneut zu holen waere derselbe Leerlauf wie in §101.
    expect(log.rpcMethods.filter((m) => m === "getAccountInfo")).toHaveLength(1);
  });

  it("liest die Uhrzeit eines Slots und fragt sie danach nicht erneut", async () => {
    const { fetchImpl, log } = fakeNet();
    const deps = buildQuoteMarketDeps({ clock: new FixedClock(T0), env: ENV, fetchImpl })!;

    const at = await deps.fetchSlotTime(SLOT);
    expect(at).toEqual(new Date(SLOT_SECONDS * 1_000));
    await deps.fetchSlotTime(SLOT);
    expect(log.rpcMethods.filter((m) => m === "getBlockTime")).toHaveLength(1);
  });

  it("merkt sich einen NICHT verfuegbaren Slot nicht", async () => {
    const { fetchImpl, log } = fakeNet({ blockTime: null });
    const deps = buildQuoteMarketDeps({ clock: new FixedClock(T0), env: ENV, fetchImpl })!;

    expect(await deps.fetchSlotTime(SLOT)).toBeNull();
    expect(await deps.fetchSlotTime(SLOT)).toBeNull();
    // Ein einmaliger Ausfall darf keinen Slot dauerhaft aussperren.
    expect(log.rpcMethods.filter((m) => m === "getBlockTime")).toHaveLength(2);
  });

  it("gibt den Betrag als BigInt weiter, nicht als Zahl", async () => {
    // 18 Stellen: jenseits von Number.MAX_SAFE_INTEGER. Ueber `number`
    // gelaufen waere der Wert hier still gerundet.
    const gross = "123456789012345678";
    const { fetchImpl } = fakeNet({ outAmount: gross });
    const deps = buildQuoteMarketDeps({ clock: new FixedClock(T0), env: ENV, fetchImpl })!;

    const quote = await deps.fetchQuote({
      inputMint: QUOTE_ANCHOR_MINT,
      outputMint: MEME,
      amountRaw: 100_000_000n,
    });
    if (quote.kind !== "OK") throw new Error("erwartet: Kurs");
    expect(quote.outAmountRaw).toBe(BigInt(gross));
    expect(quote.contextSlot).toBe(SLOT);
  });

  /**
   * Der Grund, warum kein Kurs kam — benannt statt eingeebnet.
   *
   * Der Anlass steht im Betriebslog vom 2026-09-10: von 25 Token lieferten 20
   * keinen Kurs, und dazu stand genau ein Wort da (`NO_QUOTE=20`). Ob der
   * Router keinen Weg fand, uns drosselte oder gar nicht antwortete, sah alles
   * gleich aus — drei Probleme mit drei verschiedenen Gegenmassnahmen.
   */
  it("nennt bei Drosselung die Drosselung und nicht nur 'kein Kurs'", async () => {
    const deps = buildQuoteMarketDeps({
      clock: new FixedClock(T0),
      env: ENV,
      fetchImpl: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    })!;

    const quote = await deps.fetchQuote({
      inputMint: QUOTE_ANCHOR_MINT,
      outputMint: MEME,
      amountRaw: 100_000_000n,
    });
    expect(quote).toEqual({ kind: "NONE", reason: "QUOTE_RATE_LIMITED" });
  });

  it("unterscheidet eine Sperre von einer fehlenden Route", async () => {
    const gesperrt = buildQuoteMarketDeps({
      clock: new FixedClock(T0),
      env: ENV,
      fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
    })!;
    expect(
      await gesperrt.fetchQuote({
        inputMint: QUOTE_ANCHOR_MINT,
        outputMint: MEME,
        amountRaw: 100_000_000n,
      }),
    ).toEqual({ kind: "NONE", reason: "QUOTE_BLOCKED" });

    const keinWeg = buildQuoteMarketDeps({
      clock: new FixedClock(T0),
      env: ENV,
      fetchImpl: (async () =>
        new Response("no route", { status: 400 })) as unknown as typeof fetch,
    })!;
    expect(
      await keinWeg.fetchQuote({
        inputMint: QUOTE_ANCHOR_MINT,
        outputMint: MEME,
        amountRaw: 100_000_000n,
      }),
    ).toEqual({ kind: "NONE", reason: "QUOTE_BAD_REQUEST" });
  });

  it("meldet eine unlesbare Antwort als Vertragsproblem", async () => {
    const deps = buildQuoteMarketDeps({
      clock: new FixedClock(T0),
      env: ENV,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ inputMint: QUOTE_ANCHOR_MINT }), {
          status: 200,
        })) as unknown as typeof fetch,
    })!;
    const quote = await deps.fetchQuote({
      inputMint: QUOTE_ANCHOR_MINT,
      outputMint: MEME,
      amountRaw: 100_000_000n,
    });
    expect(quote).toEqual({ kind: "NONE", reason: "QUOTE_SCHEMA_REJECTED" });
  });

  it("fragt mit der Probesumme in der kleinsten Einheit des Ankers", async () => {
    const { fetchImpl, log } = fakeNet();
    const deps = buildQuoteMarketDeps({ clock: new FixedClock(T0), env: ENV, fetchImpl })!;

    await deps.fetchQuote({
      inputMint: QUOTE_ANCHOR_MINT,
      outputMint: MEME,
      amountRaw: 100_000_000n,
    });
    const gefragt = new URL(log.calls.find((c) => c.startsWith(ENV.JUPITER_BASE_URL))!);
    expect(gefragt.pathname).toBe("/quote");
    expect(gefragt.searchParams.get("inputMint")).toBe(QUOTE_ANCHOR_MINT);
    expect(gefragt.searchParams.get("outputMint")).toBe(MEME);
    expect(gefragt.searchParams.get("amount")).toBe("100000000");
  });

  it("haelt die Probesumme bei 100 Anker-Einheiten", () => {
    // Ein Simulationsparameter, kein Marktwert — und einer, der den
    // gemessenen Preis beeinflusst. Er gehoert deshalb festgenagelt.
    expect(QUOTE_PROBE_NOTIONAL).toBe(100);
  });
});

describe("Selbstbremse gegen die Drosselung", () => {
  /**
   * Der Anlass steht im Betriebslog vom 2026-09-11: von 25 Token endeten 21
   * mit `QUOTE_RATE_LIMITED`. Die Anfragen gingen als Stoss hinaus, so
   * schnell wie die Schleife sie stellte.
   */
  /**
   * Laesst eine Reihe von Anfragen laufen und gibt zurueck, wie lange vor
   * jeder einzelnen gewartet wurde.
   */
  async function wartezeiten(
    anzahl: number,
    over: { rateLimitFirst?: number } = {},
  ): Promise<number[]> {
    const clock = new FixedClock(T0);
    const { fetchImpl } = fakeNet(over);
    const gewartet: number[] = [];

    const deps = buildQuoteMarketDeps({
      clock,
      env: ENV,
      fetchImpl,
      sleep: async (ms) => {
        gewartet.push(ms);
        // Die Uhr mitziehen — sonst rueckt der Takt nie vor und der Test
        // pruefte eine Bremse, die in Wahrheit blockiert.
        clock.advance(ms);
      },
    })!;

    const frage = {
      inputMint: QUOTE_ANCHOR_MINT,
      outputMint: MEME,
      amountRaw: 100_000_000n,
    };
    for (let i = 0; i < anzahl; i += 1) await deps.fetchQuote(frage);
    return gewartet.filter((ms) => ms > 0);
  }

  it("laesst nur die erste Anfrage ungebremst hinaus", async () => {
    const gewartet = await wartezeiten(5);

    // Kein Stoss-Puffer: nach der ersten Anfrage wartet jede weitere. Ein
    // Puffer waere hier die falsche Grosszuegigkeit — er schickt zum
    // Lauf-Beginn mehrere Anfragen gleichzeitig hinaus, und genau dieser
    // Stoss hat die Drosselung ausgeloest.
    expect(gewartet).toHaveLength(4);
    // Mindestens der Boden des Taktgebers. Die genaue Zahl steht bewusst
    // nicht hier — sie ist ein Stellwert, den die Bremse selbst nachfuehrt.
    for (const ms of gewartet) expect(ms).toBeGreaterThanOrEqual(1_000);
    // Ohne Abweisung bleibt der Takt, wo er ist: nichts zieht ihn an.
    expect(new Set(gewartet).size).toBe(1);
  });

  it("wartet nach einer Abweisung laenger als vorher", async () => {
    // Der eigentliche Zweck der Bremse. Dass die Klasse rechnen kann, steht
    // in `adaptive-pacer.test.ts`; hier wird geprueft, dass das HTTP 429
    // ueberhaupt bei ihr ankommt. Ohne diese Naht bliebe der Takt starr —
    // und starr war er schon, als 21 von 25 Anfragen abgewiesen wurden.
    const ruhig = await wartezeiten(5);
    const abgewiesen = await wartezeiten(5, { rateLimitFirst: 1 });

    expect(abgewiesen[0]).toBeGreaterThan(ruhig[0]!);
  });

  it("bremst den ersten Abruf nicht", async () => {
    // Ein Lauf mit einem einzigen Token soll nicht eine Sekunde kosten.
    const clock = new FixedClock(T0);
    const { fetchImpl } = fakeNet();
    const gewartet: number[] = [];
    const deps = buildQuoteMarketDeps({
      clock,
      env: ENV,
      fetchImpl,
      sleep: async (ms) => {
        gewartet.push(ms);
        clock.advance(ms);
      },
    })!;

    await deps.fetchQuote({ inputMint: QUOTE_ANCHOR_MINT, outputMint: MEME, amountRaw: 100_000_000n });
    expect(gewartet.filter((ms) => ms > 0)).toHaveLength(0);
  });
});
