import type { KnownProviderId } from "@sae/config";
import type { MarketDataAdapter } from "@sae/pipeline";

/** Share successful acquisitions across accounts in one token evaluation, retaining provider time. */
export function sharedMarketAdapters(adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>, now = Date.now) {
  return new Map([...adapters].map(([id, adapter]) => {
    let cached: Awaited<ReturnType<MarketDataAdapter["fetchMarket"]>> = null;
    let cachedMint: string | null = null, fetchedAt = 0;
    return [id, { providerId: adapter.providerId, capabilities: adapter.capabilities,
      async fetchMarket(mint: string) {
        if (cached !== null && cachedMint === mint && now() - fetchedAt >= 0 && now() - fetchedAt < 30000) return cached;
        const result = await adapter.fetchMarket(mint);
        cached = result; cachedMint = mint; fetchedAt = now();
        return result;
      },
    }] as const;
  }));
}
