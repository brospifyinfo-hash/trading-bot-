import { FixedClock, isMissing, isPresent } from "@sae/core";
import { JupiterQuoteAdapter } from "@sae/providers";
import type { ExecutionPlan } from "@sae/trading";
import { describe, expect, it } from "vitest";

import {
  buildQuoteSource,
  JupiterQuoteSource,
  UnavailableQuoteSource,
} from "../quote-source";

/**
 * Der Kurs, zu dem der Papierhandel eroeffnet.
 *
 * Die gefaehrlichste Stelle im ganzen Simulator: ein falscher Einstiegskurs
 * erzeugt eine Position, die es nie gegeben haette — und jede spaetere
 * Statistik rechnet damit weiter, ohne dass irgendwo etwas kaputt aussieht.
 * Geprueft wird deshalb nicht nur der Erfolgsfall, sondern vor allem, dass
 * jeder Fehlschlag zu MISSING fuehrt und zu keinem Ersatzwert.
 */

const T0 = new Date("2026-09-10T12:00:00Z");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BASE = "https://jupiter.invalid";

const PLAN: ExecutionPlan = {
  intentId: "intent-1",
  side: "buy",
  inputMint: USDC as never,
  outputMint: MEME as never,
  inAmount: 100_000_000n,
  notional: { amount: 100, currency: "EUR" } as never,
  maxSlippageBps: 75 as never,
  plannedAt: T0,
};

function antwort(outAmount: string, priceImpactPct: string): string {
  return JSON.stringify({
    inputMint: USDC,
    inAmount: "100000000",
    outputMint: MEME,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 75,
    priceImpactPct,
    routePlan: [
      {
        swapInfo: {
          ammKey: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
          label: "Raydium",
          inputMint: USDC,
          outputMint: MEME,
          inAmount: "100000000",
          outAmount,
        },
        percent: 100,
        bps: null,
      },
    ],
    contextSlot: 301_234_567,
  });
}

interface Netz {
  readonly quelle: JupiterQuoteSource;
  readonly urls: string[];
}

function quelleMit(respond: () => Response | Promise<Response>): Netz {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    return respond();
  }) as unknown as typeof fetch;

  const clock = new FixedClock(T0);
  return {
    quelle: new JupiterQuoteSource({
      adapter: new JupiterQuoteAdapter({ clock, baseUrl: BASE, fetchImpl }),
      clock,
    }),
    urls,
  };
}

describe("Kursquelle des Papierhandels", () => {
  it("liefert Menge und Preiseinfluss aus der Antwort", async () => {
    const { quelle } = quelleMit(() => new Response(antwort("25000000", "0.0123"), { status: 200 }));
    const result = await quelle.quote(PLAN);

    expect(isPresent(result)).toBe(true);
    if (!isPresent(result)) return;
    expect(result.value.outAmount).toBe(25_000_000n);
    // 0,0123 als Anteil sind 123 Basispunkte.
    expect(result.value.priceImpactBps).toBe(123);
    expect(String(result.source)).toBe("jupiter");
    // Der Anbieter nennt den Messzeitpunkt als Slot-Nummer, nicht als Zeit.
    // `null` heisst hier: nicht erhoben — ausdruecklich nicht "gleich jetzt".
    expect(result.sourceTs).toBeNull();
  });

  it("fragt mit der Slippage des PLANS, nicht mit einer Konstante", async () => {
    // Ein Quote mit fremder Toleranz beantwortet eine andere Frage.
    const { quelle, urls } = quelleMit(
      () => new Response(antwort("25000000", "0.001"), { status: 200 }),
    );
    await quelle.quote(PLAN);

    const gefragt = new URL(urls[0]!);
    expect(gefragt.searchParams.get("slippageBps")).toBe("75");
    expect(gefragt.searchParams.get("amount")).toBe("100000000");
    expect(gefragt.searchParams.get("inputMint")).toBe(USDC);
    expect(gefragt.searchParams.get("outputMint")).toBe(MEME);
  });

  it("traegt Betraege als BigInt, nicht als Zahl", async () => {
    // 18 Stellen: jenseits von Number.MAX_SAFE_INTEGER. Ueber `number`
    // gelaufen waere der Wert still gerundet — und die Position damit falsch.
    const gross = "123456789012345678";
    const { quelle } = quelleMit(() => new Response(antwort(gross, "0.002"), { status: 200 }));
    const result = await quelle.quote(PLAN);
    if (!isPresent(result)) throw new Error("erwartet: Kurs");
    expect(result.value.outAmount).toBe(BigInt(gross));
  });

  it("meldet Drosselung als solche und nicht als Ausfall", async () => {
    // Der Unterschied zaehlt: gedrosselt kommt wieder, ausgefallen nicht.
    const { quelle } = quelleMit(() => new Response("slow down", { status: 429 }));
    const result = await quelle.quote(PLAN);
    expect(isMissing(result)).toBe(true);
    if (!isMissing(result)) return;
    expect(result.reason).toBe("PROVIDER_RATE_LIMITED");
  });

  it("meldet eine Sperre als Ausfall des Anbieters", async () => {
    const { quelle } = quelleMit(() => new Response("nope", { status: 403 }));
    const result = await quelle.quote(PLAN);
    if (!isMissing(result)) throw new Error("erwartet: MISSING");
    expect(result.reason).toBe("PROVIDER_DOWN");
  });

  it("unterscheidet eine unlesbare Antwort von einem fehlenden Kurs", async () => {
    // Erreichbar und unlesbar ist ein Vertragsproblem, kein Marktbefund.
    const { quelle } = quelleMit(
      () => new Response(JSON.stringify({ inputMint: USDC }), { status: 200 }),
    );
    const result = await quelle.quote(PLAN);
    if (!isMissing(result)) throw new Error("erwartet: MISSING");
    expect(result.reason).toBe("PARSE_FAILED");
  });

  it("erfindet bei einer Menge von 0 keinen Kurs", async () => {
    const { quelle } = quelleMit(() => new Response(antwort("0", "0.001"), { status: 200 }));
    const result = await quelle.quote(PLAN);
    // Eine Ausgabe von null ist kein Kurs. Sie durchzulassen hiesse, eine
    // Position mit unendlichem Einstiegspreis zu eroeffnen.
    expect(isMissing(result)).toBe(true);
  });

  it("gibt bei einem Netzfehler MISSING zurueck und wirft nicht", async () => {
    // Eine Ausnahme hier wuerde den ganzen Entscheidungslauf abbrechen und
    // damit auch die Token, die nichts damit zu tun haben.
    const { quelle } = quelleMit(() => {
      throw new Error("ECONNRESET");
    });
    const result = await quelle.quote(PLAN);
    expect(isMissing(result)).toBe(true);
  });
});

describe("Auswahl der Kursquelle", () => {
  it("bleibt ohne Basis-URL bei der Quelle, die nichts weiss", async () => {
    const quelle = buildQuoteSource({});
    expect(quelle).toBeInstanceOf(UnavailableQuoteSource);

    // Und sie behauptet auch nichts: kein geschaetzter Einstiegskurs.
    const result = await quelle.quote(PLAN);
    if (!isMissing(result)) throw new Error("erwartet: MISSING");
    expect(result.reason).toBe("NOT_YET_COLLECTED");
  });

  it("nimmt mit Basis-URL den echten Router", () => {
    expect(buildQuoteSource({ JUPITER_BASE_URL: BASE })).toBeInstanceOf(JupiterQuoteSource);
  });
});
