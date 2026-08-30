import { describe, expect, it } from "vitest";
import { FixedClock, bps, eur, missing, mint, observed, providerId } from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY } from "@sae/simulation";
import { PaperExecutor } from "../paper-executor";
import type { ExecutionPlan, QuoteSource } from "../executor";

const T0 = new Date("2026-08-30T12:00:00Z");
const SRC = providerId("test");
const SOL = mint("So11111111111111111111111111111111111111112");
const TOKEN = mint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const plan: ExecutionPlan = {
  intentId: "intent-1",
  side: "buy",
  inputMint: SOL,
  outputMint: TOKEN,
  inAmount: 1_000_000_000n,
  notional: eur(100),
  maxSlippageBps: bps(300),
  plannedAt: T0,
};

const quoteSource = (outAmount: bigint, priceImpactBps = 120): QuoteSource => ({
  quote: async () => observed({ outAmount, priceImpactBps: bps(priceImpactBps) }, SRC, T0),
});

const emptyQuoteSource: QuoteSource = {
  quote: async () => missing("NO_DATA_FOR_TOKEN", T0, SRC),
};

const makeExecutor = (
  quotes: QuoteSource,
  overrides: { random?: () => number; drift?: () => number; failureRate?: number } = {},
) =>
  new PaperExecutor({
    clock: new FixedClock(T0),
    quotes,
    fees: { ...DEFAULT_FEES, failureRate: overrides.failureRate ?? 0 },
    latency: DEFAULT_LATENCY,
    solPrice: eur(150),
    dexFeeBps: bps(30),
    random: overrides.random ?? (() => 0.99),
    driftSample: overrides.drift ?? (() => 0),
  });

describe("PaperExecutor", () => {
  it("fuellt zum Quote-Preis, wenn keine Drift auftritt", async () => {
    const result = await makeExecutor(quoteSource(1_000_000n)).execute(plan);
    expect(result.kind).toBe("FILLED");
    if (result.kind === "FILLED") {
      expect(result.outAmount).toBe(1_000_000n);
      expect(result.realizedSlippageBps).toBe(0);
    }
  });

  it("rechnet Kosten mit demselben Modell wie der Live-Pfad", async () => {
    // Ein eigenes, guenstigeres Kostenmodell fuer Paper waere die bequemste Art,
    // sich die Statistik schoenzurechnen.
    const result = await makeExecutor(quoteSource(1_000_000n)).execute(plan);
    if (result.kind === "FILLED") {
      expect(result.costs.total.minor).toBeGreaterThan(0n);
      expect(result.costs.dexFee.minor).toBeGreaterThan(0n);
      expect(result.costs.priceImpact.minor).toBeGreaterThan(0n);
    }
  });

  it("laesst die Drift immer zulasten des Trades gehen", async () => {
    // Wer annimmt, die Verzoegerung nuetze auch mal, mittelt einen Vorteil ein,
    // den es im Live-Betrieb nicht gibt.
    const result = await makeExecutor(quoteSource(1_000_000n), { drift: () => 0.01 }).execute(plan);
    if (result.kind === "FILLED") {
      expect(result.outAmount).toBeLessThan(1_000_000n);
      expect(result.realizedSlippageBps).toBeGreaterThan(0);
    }
  });

  it("wertet auch eine guenstige Drift nicht als Vorteil", async () => {
    const result = await makeExecutor(quoteSource(1_000_000n), { drift: () => -0.05 }).execute(plan);
    if (result.kind === "FILLED") expect(result.outAmount).toBe(1_000_000n);
  });

  it("scheitert, wenn die Drift die Slippage-Toleranz sprengt", async () => {
    // Der reale Mechanismus, an dem Solana-Transaktionen scheitern.
    const result = await makeExecutor(quoteSource(1_000_000n), { drift: () => 0.05 }).execute(plan);
    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") expect(result.reason).toBe("SLIPPAGE_EXCEEDED");
  });

  it("belastet einen Fehlschlag mit Gebuehren ohne Gegenwert", async () => {
    const result = await makeExecutor(quoteSource(1_000_000n), { drift: () => 0.05 }).execute(plan);
    if (result.kind === "FAILED") {
      expect(result.costs.networkFeeLamports).toBeGreaterThan(0n);
      expect(result.costs.priorityFeeLamports).toBeGreaterThan(0n);
    }
  });

  it("modelliert Fehlschlaege unabhaengig von der Slippage", async () => {
    const result = await makeExecutor(quoteSource(1_000_000n), {
      random: () => 0.01,
      failureRate: 0.1,
    }).execute(plan);
    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") expect(result.reason).toBe("BLOCKHASH_EXPIRED");
  });

  it("bricht ohne Quote ab, statt einen Preis zu erfinden", async () => {
    const result = await makeExecutor(emptyQuoteSource).execute(plan);
    expect(result.kind).toBe("ABORTED");
    if (result.kind === "ABORTED") expect(result.reason).toBe("NO_QUOTE");
  });

  it("verursacht bei einem Abbruch keine Kosten", async () => {
    // Abgebrochen heisst: nichts gesendet. Kosten waeren hier eine Erfindung.
    const result = await makeExecutor(emptyQuoteSource).execute(plan);
    expect(result).not.toHaveProperty("costs");
  });

  it("ist bei injizierten Zufallsquellen reproduzierbar", async () => {
    // Ein Backtest, der bei jedem Lauf etwas anderes ergibt, ist keine Messung.
    const make = () => makeExecutor(quoteSource(1_000_000n), { drift: () => 0.005 });
    const a = await make().execute(plan);
    const b = await make().execute(plan);
    expect(a).toEqual(b);
  });

  it("meldet sich als Paper-Modus", () => {
    expect(makeExecutor(quoteSource(1n)).mode).toBe("paper");
  });
});
