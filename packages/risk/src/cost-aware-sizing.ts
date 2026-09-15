import { money, mulDiv, type Money } from "@sae/core";
import { computePositionSize, type SizingInputs, type SizingResult } from "./position-sizing";

export type CostAwareSizing =
  | { readonly kind: "BLOCKED"; readonly reason: "MISSING_COSTS" | "MISSING_CAPACITY" | "COSTS_EXCEED_LIMIT"; readonly sizing: SizingResult | null }
  | { readonly kind: "SIZED"; readonly sizing: SizingResult };

/**
 * Budget for entry AND the complete exit ladder, in portfolio currency.
 * Costs must be estimated for the proposed order size and number of fills.
 * Capacity comes from quotes/exposure accounting, not an assumed USD/EUR rate.
 */
export function sizeCostAwarePaper(input: Omit<SizingInputs, "minimumNotional" | "maxNotionalByLiquidity"> & {
  readonly maxNotionalByLiquidity: Money | null;
  readonly remainingExposure: Money | null;
  readonly roundTripCosts: Money | null;
  readonly maxRoundTripCostBps: number;
}): CostAwareSizing {
  if (input.roundTripCosts === null) return { kind: "BLOCKED", reason: "MISSING_COSTS", sizing: null };
  if (input.maxNotionalByLiquidity === null || input.remainingExposure === null) {
    return { kind: "BLOCKED", reason: "MISSING_CAPACITY", sizing: null };
  }
  for (const value of [input.roundTripCosts, input.maxNotionalByLiquidity, input.remainingExposure]) {
    if (input.portfolioValue.currency !== value.currency) throw new TypeError("Currency mismatch");
    if (value.minor < 0n) throw new RangeError("Negative costs or capacity");
  }
  if (!Number.isInteger(input.maxRoundTripCostBps) || input.maxRoundTripCostBps <= 0 || input.maxRoundTripCostBps > 10_000) {
    throw new RangeError("Invalid cost budget");
  }
  // Reserve all modeled costs before calculating the remaining exposure cap.
  const available = input.remainingExposure.minor - input.roundTripCosts.minor;
  const capacity = available < input.maxNotionalByLiquidity.minor ? available : input.maxNotionalByLiquidity.minor;
  const minimum = mulDiv(input.roundTripCosts.minor, 10_000n, BigInt(input.maxRoundTripCostBps), "ceil");
  const sizing = computePositionSize({
    ...input,
    maxNotionalByLiquidity: money(capacity > 0n ? capacity : 0n, input.portfolioValue.currency),
    minimumNotional: money(minimum > 0n ? minimum : 1n, input.portfolioValue.currency),
  });
  return sizing.tradeable ? { kind: "SIZED", sizing }
    : { kind: "BLOCKED", reason: "COSTS_EXCEED_LIMIT", sizing };
}
