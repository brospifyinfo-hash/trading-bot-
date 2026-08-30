import { describe, expect, it } from "vitest";
import {
  bps,
  eur,
  mint as toMint,
  missing,
  observed,
  providerId,
  walletAddress,
} from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY, estimateExecutionCosts } from "@sae/simulation";
import { validatePreTrade, type PreTradeInput } from "../pre-trade-validation";

const T0 = new Date("2026-08-30T12:00:00Z");
const SRC = providerId("test");
const WALLET = walletAddress("TradingWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const OTHER_WALLET = walletAddress("AttackerWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
const TOKEN = toMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL = toMint("So11111111111111111111111111111111111111112");
const OTHER_TOKEN = toMint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const costs = estimateExecutionCosts({
  notional: eur(100),
  dexFeeBps: bps(30),
  priceImpactBps: bps(120),
  solPrice: eur(150),
  fees: DEFAULT_FEES,
  latency: DEFAULT_LATENCY,
});

const input = (overrides: Partial<PreTradeInput> = {}): PreTradeInput => ({
  side: "buy",
  expectedWallet: WALLET,
  expectedTokenMint: TOKEN,
  intentExpiresAt: new Date(T0.getTime() + 600_000),
  quote: {
    inputMint: SOL,
    outputMint: TOKEN,
    inAmount: 100_000_000n,
    outAmount: 1_000_000n,
    minOutAmount: 970_000n,
    slippageBps: bps(300),
    quotedAt: T0,
    ...overrides.quote,
  },
  plannedInAmount: 100_000_000n,
  amountToleranceBps: bps(100),
  balances: {
    wallet: WALLET,
    lamports: 500_000_000n,
    tokens: new Map(),
    slot: 300_000_000,
    readAt: T0,
    ...overrides.balances,
  },
  rentBufferLamports: 10_000_000n,
  costs,
  expectedEdge: observed(eur(5), SRC, T0),
  quoteMaxAgeMs: 5_000,
  chainStateMaxAgeMs: 10_000,
  now: new Date(T0.getTime() + 1_000),
  ...overrides,
});

describe("validatePreTrade", () => {
  it("laesst eine korrekte Transaktion durch", () => {
    const result = validatePreTrade(input());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("meldet den gesamten SOL-Abfluss fuer die Signer-Policy", () => {
    const result = validatePreTrade(input());
    expect(result.totalLamportsOut).toBe(
      100_000_000n + costs.networkFeeLamports + costs.priorityFeeLamports + costs.tipLamports,
    );
  });

  it("lehnt eine fremde Wallet ab", () => {
    const result = validatePreTrade(
      input({ balances: { ...input().balances, wallet: OTHER_WALLET } }),
    );
    expect(result.failures).toContain("WRONG_WALLET");
  });

  it("lehnt einen anderen Ziel-Token ab", () => {
    const result = validatePreTrade(
      input({ quote: { ...input().quote, outputMint: OTHER_TOKEN } }),
    );
    expect(result.failures).toContain("WRONG_OUTPUT_MINT");
  });

  it("lehnt einen abweichenden Betrag ab", () => {
    const result = validatePreTrade(
      input({ quote: { ...input().quote, inAmount: 150_000_000n } }),
    );
    expect(result.failures).toContain("AMOUNT_OUT_OF_BOUNDS");
  });

  it("erlaubt eine kleine Abweichung innerhalb der Toleranz", () => {
    const result = validatePreTrade(
      input({ quote: { ...input().quote, inAmount: 100_500_000n } }),
    );
    expect(result.failures).not.toContain("AMOUNT_OUT_OF_BOUNDS");
  });

  it("lehnt eine fehlende Mindestausgabemenge ab", () => {
    const result = validatePreTrade(input({ quote: { ...input().quote, minOutAmount: null } }));
    expect(result.failures).toContain("MIN_OUT_MISSING");
  });

  it("lehnt minOut = 0 ab", () => {
    const result = validatePreTrade(input({ quote: { ...input().quote, minOutAmount: 0n } }));
    expect(result.failures).toContain("MIN_OUT_ZERO");
  });

  it("lehnt eine Mindestmenge ab, die nicht zur Slippage passt", () => {
    // Weicht sie ab, hat jemand entweder den Quote oder die Toleranz veraendert.
    const result = validatePreTrade(
      input({ quote: { ...input().quote, minOutAmount: 500_000n } }),
    );
    expect(result.failures).toContain("MIN_OUT_INCONSISTENT_WITH_SLIPPAGE");
  });

  describe("Guthaben", () => {
    it("lehnt ab, wenn der Handelsbetrag allein nicht gedeckt ist", () => {
      const result = validatePreTrade(
        input({ balances: { ...input().balances, lamports: 50_000_000n } }),
      );
      expect(result.failures).toContain("INSUFFICIENT_SOL_FOR_TRADE");
    });

    it("lehnt ab, wenn der Betrag reicht, aber die Gebuehren nicht", () => {
      // Der klassische Fehler: nur den Handelsbetrag pruefen. Die Transaktion
      // scheitert dann on-chain, kostet trotzdem Gebuehren, und im Log steht ein
      // nichtssagender Programmfehler.
      const result = validatePreTrade(
        input({ balances: { ...input().balances, lamports: 100_000_100n } }),
      );
      expect(result.failures).toContain("INSUFFICIENT_SOL_FOR_FEES");
      expect(result.failures).not.toContain("INSUFFICIENT_SOL_FOR_TRADE");
    });

    it("beruecksichtigt die Mietreserve", () => {
      const justEnoughForFees =
        100_000_000n + costs.networkFeeLamports + costs.priorityFeeLamports + 1_000n;
      const result = validatePreTrade(
        input({ balances: { ...input().balances, lamports: justEnoughForFees } }),
      );
      expect(result.failures).toContain("INSUFFICIENT_SOL_FOR_FEES");
    });
  });

  describe("Frische", () => {
    it("lehnt ein veraltetes Quote ab", () => {
      const result = validatePreTrade(input({ now: new Date(T0.getTime() + 30_000) }));
      expect(result.failures).toContain("QUOTE_STALE");
    });

    it("lehnt einen veralteten Kontostand ab", () => {
      // Genauso gefaehrlich wie ein altes Quote: er kann bereits durch eine
      // andere Transaktion verbraucht sein.
      const result = validatePreTrade(
        input({
          quote: { ...input().quote, quotedAt: new Date(T0.getTime() + 29_000) },
          now: new Date(T0.getTime() + 30_000),
        }),
      );
      expect(result.failures).toContain("CHAIN_STATE_STALE");
    });

    it("lehnt einen abgelaufenen Intent ab", () => {
      const result = validatePreTrade(
        input({
          intentExpiresAt: new Date(T0.getTime() - 1_000),
          quote: { ...input().quote, quotedAt: new Date(T0.getTime() + 500) },
        }),
      );
      expect(result.failures).toContain("INTENT_EXPIRED");
    });
  });

  it("lehnt ab, wenn die Wallet den Token bereits haelt", () => {
    // Vierte Ebene des Duplikatschutzes, direkt vor dem Signieren.
    const result = validatePreTrade(
      input({
        balances: { ...input().balances, tokens: new Map([[TOKEN, 500n]]) },
      }),
    );
    expect(result.failures).toContain("POSITION_ALREADY_HELD");
  });

  it("lehnt ab, wenn die Kosten den erwarteten Vorteil auffressen", () => {
    const result = validatePreTrade(input({ expectedEdge: observed(eur(0.5), SRC, T0) }));
    expect(result.failures).toContain("COSTS_EXCEED_EDGE");
  });

  it("prueft den Vorteil nicht, wenn er unbekannt ist", () => {
    // Diese Entscheidung faellt in der Decision-Engine, die den Modus kennt.
    // Dieselbe Regel an zwei Stellen zu pruefen fuehrt dazu, dass sie
    // irgendwann auseinanderlaufen.
    const result = validatePreTrade(
      input({ expectedEdge: missing("NOT_YET_COLLECTED", T0, SRC) }),
    );
    expect(result.failures).not.toContain("COSTS_EXCEED_EDGE");
    expect(result.ok).toBe(true);
  });

  describe("Verkauf", () => {
    const sell = (overrides: Partial<PreTradeInput> = {}): PreTradeInput => {
      const base = input();
      return {
        ...base,
        side: "sell",
        quote: { ...base.quote, inputMint: TOKEN, outputMint: SOL, inAmount: 1_000_000n },
        plannedInAmount: 1_000_000n,
        balances: { ...base.balances, tokens: new Map([[TOKEN, 1_000_000n]]) },
        ...overrides,
      };
    };

    it("laesst einen gedeckten Verkauf durch", () => {
      const result = validatePreTrade(sell());
      expect(result.ok).toBe(true);
    });

    it("verlangt beim Verkauf einen Bestand, statt ihn zu verbieten", () => {
      // Die umgekehrte Bedingung zum Kauf. Eine Validierung, die nur den Kauf
      // kennt, wuerde hier POSITION_ALREADY_HELD melden — und den Ausstieg
      // blockieren, also genau den Pfad, auf den es im Ernstfall ankommt.
      const result = validatePreTrade(sell());
      expect(result.failures).not.toContain("POSITION_ALREADY_HELD");
    });

    it("lehnt einen Verkauf ohne ausreichenden Bestand ab", () => {
      const base = sell();
      const result = validatePreTrade({
        ...base,
        balances: { ...base.balances, tokens: new Map([[TOKEN, 500n]]) },
      });
      expect(result.failures).toContain("INSUFFICIENT_TOKEN_BALANCE");
    });

    it("rechnet beim Verkauf nur die Gebuehren als SOL-Abfluss", () => {
      const result = validatePreTrade(sell());
      expect(result.totalLamportsOut).toBe(
        costs.networkFeeLamports + costs.priorityFeeLamports + costs.tipLamports,
      );
    });

    it("lehnt einen Verkauf ohne SOL fuer die Gebuehren ab", () => {
      // Die Falle, in die eine voll investierte Wallet laeuft: Token da, aber
      // kein SOL mehr — und damit kein Weg aus der Position heraus.
      const base = sell();
      const result = validatePreTrade({
        ...base,
        balances: { ...base.balances, lamports: 1_000n },
      });
      expect(result.failures).toContain("INSUFFICIENT_SOL_FOR_FEES");
    });

    it("prueft beim Verkauf den Eingabe-Mint", () => {
      const base = sell();
      const result = validatePreTrade({
        ...base,
        quote: { ...base.quote, inputMint: OTHER_TOKEN },
      });
      expect(result.failures).toContain("WRONG_OUTPUT_MINT");
    });
  });

  it("sammelt mehrere Fehler statt beim ersten abzubrechen", () => {
    // Wer nur den ersten Fehler meldet, repariert im Zweifel dreimal.
    const result = validatePreTrade(
      input({
        balances: { ...input().balances, wallet: OTHER_WALLET },
        quote: { ...input().quote, outputMint: OTHER_TOKEN, minOutAmount: 0n },
      }),
    );
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });

  it("wirft bei gemischten Waehrungen", () => {
    expect(() =>
      validatePreTrade(
        input({ expectedEdge: observed({ minor: 500n, currency: "USD" }, SRC, T0) }),
      ),
    ).toThrow(TypeError);
  });
});
