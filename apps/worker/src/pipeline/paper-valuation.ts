import { systemClock, type Clock } from "@sae/core";
import type { ProviderEnv } from "@sae/config";
import { CoinbaseFiatValuation, valueTokenRaw } from "@sae/providers";
import { buildDecimalsReader, QUOTE_ANCHOR_MINT } from "./quote-market-source";
import type { PositionMonitorDeps } from "./position-monitor";

/** Fiat reference for the actual USDC received, with no 1-USDC=1-EUR assumption. */
export function buildPaperValuation(env: ProviderEnv, clock: Clock = systemClock, inputs: {
  readonly source?: Pick<CoinbaseFiatValuation, "ticker">;
  readonly decimalsOf?: (mint: string) => Promise<number | null>;
} = {}): NonNullable<PositionMonitorDeps["loadValuation"]> {
  const source = inputs.source ?? new CoinbaseFiatValuation(clock);
  const decimalsOf = inputs.decimalsOf ?? buildDecimalsReader({ env, clock });
  return async (currency) => {
    if (decimalsOf === null) return null;
    const [anchor, sol, decimals] = await Promise.all([
      source.ticker("USDC", currency), source.ticker("SOL", currency), decimalsOf(QUOTE_ANCHOR_MINT),
    ]);
    if (anchor === null || sol === null || decimals === null) return null;
    return {
      solPrice: valueTokenRaw(1n, 0, sol, currency, "ask"),
      valueFill: async ({ amountRaw, mint, currency: requested, at }) => {
        const age = at.getTime() - anchor.observedAt.getTime();
        if (mint !== QUOTE_ANCHOR_MINT || requested !== currency || age < 0 || age >= 120_000) return null;
        return {
          proceeds: valueTokenRaw(amountRaw, decimals, anchor, currency, "bid"),
          observedAt: anchor.observedAt,
          source: `COINBASE_REFERENCE:${anchor.product}:bid;SOL:${sol.product}:ask:${sol.observedAt.toISOString()}`,
        };
      },
    };
  };
}
