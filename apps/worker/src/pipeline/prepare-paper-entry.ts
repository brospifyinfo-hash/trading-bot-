import { bps, isPresent, money, mulDiv, missing, type Clock } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE, type StrategyParameters } from "@sae/config";
import { DEFAULT_FEES, DEFAULT_LATENCY, estimateExecutionCosts } from "@sae/simulation";
import { PaperExecutor, type ExecutionPlan, type QuoteSource } from "@sae/trading";
import { computePositionSize, checkExposure } from "@sae/risk";
import type { PaperAccount } from "./paper-account";
import type { PaperValuation } from "./paper-valuation";
import type { PipelineDeps } from "./opportunity-pipeline";

export type PreparedPaperEntry = { readonly kind: "BLOCKED"; readonly reason: string } | {
  readonly kind: "READY";
  readonly update: Pick<PipelineDeps, "executor" | "riskBasedEntry" | "decisionContext">;
};

/** All quote requests are read-only. No position or intent is created here. */
export async function preparePaperEntry(input: {
  readonly account: PaperAccount;
  readonly valuation: PaperValuation | null;
  readonly quotes: QuoteSource;
  readonly clock: Clock;
  readonly parameters: StrategyParameters;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly tokenId: string;
  readonly context: PipelineDeps["decisionContext"];
  readonly random?: () => number;
}): Promise<PreparedPaperEntry> {
  const block = (reason: string): PreparedPaperEntry => ({ kind: "BLOCKED", reason });
  const { account, valuation, parameters, clock } = input;
  if (account.kind !== "READY") return block(account.reason);
  if (valuation === null) return block("NO_VALUATION");
  if (account.cash.minor <= 0n) return block("INSUFFICIENT_PAPER_CASH");
  if (account.portfolio.openPositions.some((p) => p.tokenId === input.tokenId)) return block("DUPLICATE_TOKEN");
  const sizing = computePositionSize({ portfolioValue: account.portfolio.value, evConfidence: 0,
    stopDistance: parameters.exit.stopLossBps / 10000, maxNotionalByLiquidity: account.cash,
    minimumNotional: money(1n, account.cash.currency), parameters });
  const purchase = valuation.preparePurchase(sizing.size, clock.now());
  if (purchase === null) return block("NO_ORDER_VALUATION");
  const plan: ExecutionPlan = { intentId: "paper-preflight", side: "buy", inputMint: input.inputMint as never,
    outputMint: input.outputMint as never, inAmount: purchase.amountRaw, notional: purchase.notional,
    maxSlippageBps: bps(parameters.risk.maxSlippageBps), plannedAt: clock.now() };
  const quote = await input.quotes.quote(plan);
  type PresentQuote = Extract<Awaited<ReturnType<QuoteSource["quote"]>>, { kind: "OBSERVED" }>;
  const valid = (q: Awaited<ReturnType<QuoteSource["quote"]>>): q is PresentQuote => {
    const age = clock.now().getTime() - q.observedAt.getTime();
    return isPresent(q) && q.value.outAmount > 0n && Number.isFinite(q.value.priceImpactBps) &&
      q.value.priceImpactBps >= 0 && q.value.priceImpactBps <= parameters.risk.maxPriceImpactBps && age >= 0 && age < 120000;
  };
  if (!valid(quote)) return block("NO_EXECUTABLE_BUY_QUOTE");
  const cost = (notional: typeof purchase.notional, q: PresentQuote) => estimateExecutionCosts({
    notional, priceImpactBps: q.value.priceImpactBps, solPrice: valuation.solPrice,
    dexFeeBps: bps(25), fees: DEFAULT_FEES, latency: DEFAULT_LATENCY,
  }).total.minor;
  let oldest = Math.min(quote.observedAt.getTime(), purchase.observedAt.getTime());
  let ladderCosts = 0n;
  let ladderProceeds = 0n;
  let assigned = 0n;
  const portions = parameters.exit.takeProfits.map((tp) => {
    const raw = quote.value.outAmount * BigInt(tp.sellPortionBps) / 10000n;
    assigned += raw; return raw;
  });
  portions.push(quote.value.outAmount - assigned);
  const sell = async (amount: bigint) => {
    const reference = money(mulDiv(purchase.notional.minor, amount, quote.value.outAmount, "ceil"), purchase.notional.currency);
    const q = await input.quotes.quote({ ...plan, side: "sell", inputMint: plan.outputMint, outputMint: plan.inputMint,
      inAmount: amount, notional: reference, plannedAt: clock.now() });
    if (!valid(q)) return null;
    oldest = Math.min(oldest, q.observedAt.getTime());
    const valued = await valuation.valueFill({ amountRaw: q.value.outAmount, mint: input.inputMint,
      currency: reference.currency, at: clock.now() });
    if (valued === null) return null;
    // Higher current proceeds increase proportional fees; never assume future target prices.
    return { fee: cost(valued.proceeds.minor > reference.minor ? valued.proceeds : reference, q), proceeds: valued.proceeds.minor };
  };
  for (const amount of portions) {
    if (amount === 0n) continue;
    const fee = await sell(amount);
    if (fee === null) return block("NO_EXECUTABLE_EXIT_LADDER");
    ladderCosts += fee.fee;
    ladderProceeds += fee.proceeds;
  }
  const fullExit = await sell(quote.value.outAmount);
  if (fullExit === null) return block("NO_EXECUTABLE_FULL_EXIT");
  const capacityRaw = mulDiv(quote.value.outAmount, BigInt(Math.ceil(parameters.risk.minExitCapacityRatio * 10000)), 10000n, "ceil");
  if (await sell(capacityRaw) === null) return block("INSUFFICIENT_EXIT_CAPACITY");
  const shortfall = (proceeds: bigint) => purchase.notional.minor > proceeds ? purchase.notional.minor - proceeds : 0n;
  const ladderScenario = ladderCosts + shortfall(ladderProceeds);
  const fullScenario = fullExit.fee + shortfall(fullExit.proceeds);
  const total = cost(purchase.notional, quote) + (ladderScenario > fullScenario ? ladderScenario : fullScenario);
  const reserve = money(total, purchase.notional.currency);
  if (total * 10000n > purchase.notional.minor * BigInt(MEMECOIN_PAPER_CANDIDATE.maxRoundTripCostBps)) return block("COSTS_EXCEED_LIMIT");
  if (purchase.notional.minor + total > account.cash.minor) return block("INSUFFICIENT_PAPER_CASH");
  const exposure = checkExposure(account.portfolio, money(purchase.notional.minor + total, account.cash.currency), parameters);
  if (!exposure.withinLimits) return block(exposure.violations[0] ?? "EXPOSURE_LIMIT");
  if (clock.now().getTime() - oldest >= 120000 || valuation.preparePurchase(sizing.size, clock.now()) === null) return block("STALE_PREFLIGHT");
  // Execute precisely the inspected buy quote, never a second, differently sized quote.
  const inspected: QuoteSource = { quote: async (actual) => {
    if (actual.side !== "buy" || actual.inAmount !== plan.inAmount || actual.inputMint !== plan.inputMint ||
      actual.outputMint !== plan.outputMint || actual.notional.minor !== plan.notional.minor ||
      actual.notional.currency !== plan.notional.currency || !valid(quote) ||
      clock.now().getTime() - oldest >= 120000 || valuation.preparePurchase(sizing.size, clock.now()) === null) {
      return missing("STALE_BEYOND_THRESHOLD", clock.now(), null);
    }
    return quote;
  } };
  return { kind: "READY", update: {
    riskBasedEntry: { amountRaw: purchase.amountRaw, notional: purchase.notional, roundTripCosts: reserve, quotedAt: new Date(oldest) },
    decisionContext: { ...input.context, sizing: { ...sizing, size: purchase.notional, tradeable: true }, exposureViolations: [] },
    executor: new PaperExecutor({ clock, quotes: inspected, fees: DEFAULT_FEES, latency: DEFAULT_LATENCY,
      solPrice: valuation.solPrice, dexFeeBps: bps(25), random: input.random ?? Math.random, driftSample: () => 0 }),
  } };
}
