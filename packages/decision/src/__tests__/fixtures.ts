import { decisionId, eur, missing, observed, providerId, strategyVersionId, tokenId } from "@sae/core";
import type { Maybe } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { computeScores, type FeatureVector } from "@sae/scoring";
import { computePositionSize } from "@sae/risk";
import { estimateEv, type OutcomeSample } from "../ev";
import type { DecisionContext } from "../engine";

export const SRC = providerId("fixture");
export const T0 = new Date("2026-08-30T12:00:00Z");
export const val = <T>(v: T): Maybe<T> => observed(v, SRC, T0);
export const gone = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", T0, SRC);

/**
 * Ein Token, das die Einstiegsschwelle deutlich uebertrifft.
 *
 * Die Werte sind bewusst klar ueber der Schwelle und nicht knapp darueber: ein
 * Fixture, das bei 75,4 liegt, wuerde bei jeder Gewichtsaenderung umkippen und
 * dann Tests brechen lassen, die mit der Aenderung nichts zu tun haben.
 * Der Grenzfall wird separat getestet (siehe engine.test.ts).
 */
export function goodFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
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
      holders: val(2_500),
      holderGrowth: val(300),
      distinctActors: val(2_300),
      largestClusterSharePct: val(8),
    },
    execution: {
      expectedCostBps: val(180),
      exitCapacityRatio: val(6),
      priceImpactBps: val(90),
    },
    pending: {
      smartMoneyBuyers: val(7),
      smartMoneySellers: val(0),
      socialAuthenticity: val(75),
      socialMomentum: val(70),
      devScore: val(70),
      narrativeScore: val(65),
    },
    ...overrides,
  };
}

const profitableSample: OutcomeSample[] = [
  ...Array.from({ length: 70 }, () => ({ netReturn: 0.45 })),
  ...Array.from({ length: 50 }, () => ({ netReturn: -0.18 })),
];

export function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const features = overrides.features ?? goodFeatures();
  const scoring = overrides.scoring ?? computeScores(features);
  const sizing =
    overrides.sizing ??
    computePositionSize({
      portfolioValue: eur(1_000),
      stopDistance: 0.2,
      maxNotionalByLiquidity: eur(500),
      evConfidence: 0.8,
      minimumNotional: eur(5),
      parameters: DEFAULT_STRATEGY_PARAMETERS,
    });
  const ev =
    overrides.ev ??
    estimateEv({
      sample: profitableSample,
      expectedCostFraction: 0.02,
      minSampleSize: DEFAULT_STRATEGY_PARAMETERS.entryGates.minEvSampleSize,
    });

  return {
    decisionId: decisionId("decision-1"),
    strategyVersionId: strategyVersionId("sv-1"),
    features,
    scoring,
    parameters: DEFAULT_STRATEGY_PARAMETERS,
    criticalProvidersUnavailable: [],
    tokenBlacklisted: false,
    hasOpenIntentOnMint: false,
    executionMode: "paper",
    decisionMode: "auto",
    liveTradingEnabled: false,
    breakers: { open: [], entriesBlocked: false, allTradingBlocked: false, reasons: [] },
    sizing,
    ev,
    exposureViolations: [],
    ...overrides,
  };
}

/**
 * Derselbe Token, aber nur solide statt stark: drei qualifizierte Kaeufer und
 * moderates Holder-Wachstum. Landet unter der Einstiegsschwelle — die
 * beabsichtigte Konservativitaet der Standardparameter.
 */
export function solidButNotEnoughFeatures(): FeatureVector {
  const base = goodFeatures();
  return {
    ...base,
    holder: { ...base.holder, holders: val(900), holderGrowth: val(70), distinctActors: val(820) },
    pending: { ...base.pending, smartMoneyBuyers: val(3) },
  };
}

export const emptyEv = estimateEv({
  sample: [],
  expectedCostFraction: 0.02,
  minSampleSize: 100,
});
