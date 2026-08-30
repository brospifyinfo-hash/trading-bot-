import { missing, observed, providerId, tokenId, type Maybe } from "@sae/core";
import type { FeatureVector } from "../features";

export const SRC = providerId("fixture");
export const T0 = new Date("2026-08-30T12:00:00Z");

export const val = <T>(v: T): Maybe<T> => observed(v, SRC, T0);
export const gone = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", T0, SRC);

/**
 * Ein Token, das in allen berechenbaren Kategorien gut dasteht.
 * Die "pending"-Felder fehlen — genau wie im echten Betrieb vor Phase 6–8.
 */
export function healthyToken(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    tokenId: tokenId("token-1"),
    asOf: T0,
    security: {
      mintAuthorityActive: val(false),
      freezeAuthorityActive: val(false),
      lpBurnedOrLocked: val(true),
      top10HolderSharePct: val(18),
      topHolderSharePct: val(5),
      riskLevel: val("LOW" as const),
    },
    market: {
      priceUsd: val(0.00042),
      liquidityUsd: val(120_000),
      marketCapUsd: val(1_800_000),
      volume24hUsd: val(450_000),
      tokenAgeSeconds: val(3_600),
    },
    momentum: {
      priceChange5m: val(0.18),
      priceChange1h: val(0.42),
      volumeAcceleration: val(2.4),
      buys5m: val(180),
      sells5m: val(70),
    },
    holder: {
      holders: val(900),
      holderGrowth: val(70),
      distinctActors: val(820),
      largestClusterSharePct: val(8),
    },
    execution: {
      expectedCostBps: val(180),
      exitCapacityRatio: val(6),
      priceImpactBps: val(90),
    },
    pending: {
      smartMoneyBuyers: gone(),
      smartMoneySellers: gone(),
      socialAuthenticity: gone(),
      socialMomentum: gone(),
      devScore: gone(),
      narrativeScore: gone(),
    },
    ...overrides,
  };
}
