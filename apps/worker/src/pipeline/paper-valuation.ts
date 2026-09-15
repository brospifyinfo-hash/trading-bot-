import { systemClock, type Clock, type Currency, type Money } from "@sae/core";
import type { ProviderEnv } from "@sae/config";
import { CoinbaseFiatValuation, valueTokenRaw, tokenRawForBudget } from "@sae/providers";
import { buildDecimalsReader, QUOTE_ANCHOR_MINT } from "./quote-market-source";
import type { PositionMonitorDeps } from "./position-monitor";

export interface PaperValuation {
  readonly solPrice: Money;
  readonly valueFill: NonNullable<PositionMonitorDeps["valueFill"]>;
  /** Ask-valued amount in anchor raw units, bounded by the approved fiat budget. */
  readonly preparePurchase: (budget: Money, at: Date) => {
    readonly amountRaw: bigint;
    readonly notional: Money;
    readonly observedAt: Date;
    readonly source: string;
  } | null;
}

/** Fiat reference for the actual USDC received, with no 1-USDC=1-EUR assumption. */
export function buildPaperValuation(env: ProviderEnv, clock: Clock = systemClock, inputs: {
  readonly source?: Pick<CoinbaseFiatValuation, "ticker">;
  readonly decimalsOf?: (mint: string) => Promise<number | null>;
} = {}): (currency: Currency) => Promise<PaperValuation | null> {
  const source = inputs.source ?? new CoinbaseFiatValuation(clock);
  const decimalsOf = inputs.decimalsOf ?? buildDecimalsReader({ env, clock });
  return async (currency) => {
    if (decimalsOf === null) return null;
    const [anchor, sol, decimals] = await Promise.all([
      source.ticker("USDC", currency), source.ticker("SOL", currency), decimalsOf(QUOTE_ANCHOR_MINT),
    ]);
    if (anchor === null || sol === null || decimals === null) return null;
    const fresh = (at: Date): boolean => [anchor, sol].every((ticker) => {
      const age = at.getTime() - ticker.observedAt.getTime();
      return Number.isFinite(age) && age >= 0 && age < 120_000;
    });
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !fresh(clock.now())) return null;
    return {
      preparePurchase: (budget, at) => {
        if (budget.currency !== currency || budget.minor <= 0n || !fresh(at)) return null;
        const amountRaw = tokenRawForBudget(budget, decimals, anchor);
        if (amountRaw <= 0n) return null;
        return {
          amountRaw, notional: valueTokenRaw(amountRaw, decimals, anchor, currency, "ask"),
          observedAt: anchor.observedAt,
          source: `COINBASE_REFERENCE:${anchor.product}:ask;SOL:${sol.product}:ask:${sol.observedAt.toISOString()}`,
        };
      },
      solPrice: valueTokenRaw(1n, 0, sol, currency, "ask"),
      valueFill: async ({ amountRaw, mint, currency: requested, at }) => {
        if (mint !== QUOTE_ANCHOR_MINT || requested !== currency || !fresh(at)) return null;
        return {
          proceeds: valueTokenRaw(amountRaw, decimals, anchor, currency, "bid"),
          observedAt: anchor.observedAt,
          source: `COINBASE_REFERENCE:${anchor.product}:bid;SOL:${sol.product}:ask:${sol.observedAt.toISOString()}`,
        };
      },
    };
  };
}
