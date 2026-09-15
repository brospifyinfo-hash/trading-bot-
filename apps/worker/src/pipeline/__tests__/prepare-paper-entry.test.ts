import { describe, expect, it } from "vitest";
import { FixedClock, bps, eur, money, missing, observed, providerId } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { reconcilePaperAccount } from "../paper-account";
import { preparePaperEntry } from "../prepare-paper-entry";
import type { PaperValuation } from "../paper-valuation";
import type { PipelineDeps } from "../opportunity-pipeline";
import type { ExecutionPlan, QuoteSource } from "@sae/trading";

const at = new Date("2026-09-14T12:00:00Z");
const parameters = MEMECOIN_PAPER_CANDIDATE.parameters;
const valuation: PaperValuation = {
  solPrice: eur(100),
  preparePurchase: (budget) => ({ amountRaw: budget.minor * 10000n, notional: budget, observedAt: at, source: "TEST_FIXTURE:parity" }),
  valueFill: async ({ amountRaw, currency }) => ({ proceeds: money(amountRaw / 10000n, currency), observedAt: at, source: "TEST_FIXTURE:parity" }),
};
const context: PipelineDeps["decisionContext"] = {
  executionMode: "paper", decisionMode: "auto", liveTradingEnabled: false, tokenBlacklisted: false,
  hasOpenIntentOnMint: false, criticalProvidersUnavailable: [], exposureViolations: [],
  breakers: { open: [], entriesBlocked: false, allTradingBlocked: false, reasons: [] },
  sizing: { size: eur(100), tradeable: true, bindingConstraint: "RISK_BUDGET",
    candidates: { RISK_BUDGET: eur(100), LIQUIDITY: eur(100), CONFIDENCE: eur(100), PORTFOLIO_CAP: eur(100) } },
  ev: { estimate: { kind: "UNKNOWN", reason: "INSUFFICIENT_SAMPLE", sampleSize: 0 },
    pointEv: null, conservativeEv: null, winRate: null, winRateLowerBound: null, avgWin: null, avgLoss: null },
};
function setup() {
  const clock = new FixedClock(at);
  const requests: ExecutionPlan[] = [];
  const quotes: QuoteSource = { quote: async (plan) => {
    requests.push(plan);
    return observed({ outAmount: plan.inAmount, priceImpactBps: bps(0) }, providerId("TEST_FIXTURE"), clock.now());
  } };
  return { requests, input: { account: reconcilePaperAccount({ initialCash: eur(3000), positions: [], events: [], asOf: at }),
    valuation, quotes, clock, parameters, inputMint: "anchor", outputMint: "token", tokenId: "t", context, random: () => 1 } };
}

describe("quote-sized paper preflight", () => {
  it("quotes all exit portions and capacity, then executes exactly the inspected buy", async () => {
    const { input, requests } = setup();
    const prepared = await preparePaperEntry(input);
    expect(prepared.kind).toBe("READY");
    if (prepared.kind !== "READY") return;
    expect(requests.map((p) => p.side)).toEqual(["buy", "sell", "sell", "sell", "sell", "sell", "sell"]);
    expect(requests.slice(1, 5).reduce((sum, p) => sum + p.inAmount, 0n)).toBe(requests[0]!.inAmount);
    expect(requests[6]!.inAmount).toBe(requests[0]!.inAmount * 3n);
    expect(prepared.update.riskBasedEntry?.notional).toEqual(eur(18.75));
    const result = await prepared.update.executor.execute(requests[0]!);
    expect(result.kind).toBe("FILLED");
    expect(requests).toHaveLength(7); // No replacement quote during execution.
    expect((await prepared.update.executor.execute({ ...requests[0]!, inAmount: 100000000n })).kind).toBe("ABORTED");
    input.clock.set(new Date(at.getTime() + 120000));
    expect((await prepared.update.executor.execute(requests[0]!)).kind).toBe("ABORTED");
  });
  it("blocks expensive impact without increasing the approved size", async () => {
    const { input, requests } = setup();
    input.quotes.quote = async (plan) => { requests.push(plan); return observed({ outAmount: plan.inAmount, priceImpactBps: bps(100) }, providerId("TEST_FIXTURE"), at); };
    expect(await preparePaperEntry(input)).toEqual({ kind: "BLOCKED", reason: "COSTS_EXCEED_LIMIT" });
    expect(requests[0]!.notional).toEqual(eur(18.75));
  });
  it("blocks unavailable partial exits or capacity", async () => {
    for (const failedRequest of [2, 7]) {
      const { input } = setup(); let count = 0;
      input.quotes.quote = async (plan) => ++count === failedRequest ? missing("PROVIDER_DOWN", at, null)
        : observed({ outAmount: plan.inAmount, priceImpactBps: bps(0) }, providerId("TEST_FIXTURE"), at);
      expect((await preparePaperEntry(input)).kind).toBe("BLOCKED");
    }
  });
  it("includes the round-trip quote and fiat spread in the cost gate", async () => {
    const { input } = setup();
    const widerSpread: PaperValuation = { ...valuation, valueFill: async ({ amountRaw, currency }) => ({
      proceeds: money(amountRaw * 95n / 1000000n, currency), observedAt: at, source: "TEST_FIXTURE:spread",
    }) };
    expect(await preparePaperEntry({ ...input, valuation: widerSpread })).toEqual({ kind: "BLOCKED", reason: "COSTS_EXCEED_LIMIT" });
  });
  it("does not quote when fiat valuation is unknown", async () => {
    const { input, requests } = setup();
    expect(await preparePaperEntry({ ...input, valuation: null })).toEqual({ kind: "BLOCKED", reason: "NO_VALUATION" });
    expect(requests).toHaveLength(0);
  });
});
