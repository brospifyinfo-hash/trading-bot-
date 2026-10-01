import { DEFAULT_STRATEGY_PARAMETERS } from "./defaults";
import { parseStrategyParameters } from "./strategy-schema";

/** Research candidate, not an activation flag or a profitability claim (§130). */
export const MEMECOIN_PAPER_CANDIDATE = {
  strategyId: "memecoin-risk-managed",
  version: "1.0.0",
  executionMode: "paper",
  validationStatus: "UNVALIDATED",
  // Total modeled entry + all planned exits; no substitution for measured fees.
  maxRoundTripCostBps: 200,
  parameters: parseStrategyParameters({
    ...DEFAULT_STRATEGY_PARAMETERS,
    risk: {
      ...DEFAULT_STRATEGY_PARAMETERS.risk,
      riskPerTradePct: 0.5,
      maxPositionPct: 3,
      maxPortfolioExposurePct: 10,
      maxDailyLossPct: 3,
      maxOpenPositions: 4,
      maxConsecutiveLosses: 3,
    },
    exit: {
      ...DEFAULT_STRATEGY_PARAMETERS.exit,
      stopLossBps: 2_000,
      takeProfits: [
        { index: 1, triggerGainBps: 2_500, sellPortionBps: 4_000 },
        { index: 2, triggerGainBps: 5_000, sellPortionBps: 3_000 },
        { index: 3, triggerGainBps: 10_000, sellPortionBps: 2_000 },
      ],
      trailingStopBps: 1_500,
      maxHoldingTimeSeconds: 21_600,
    },
  }),
} as const;

/** Separate virtual account; experimental, never an update to Standard's ledger. */
export const MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE = {
  ...MEMECOIN_PAPER_CANDIDATE,
  strategyId: "memecoin-active-paper",
  version: "1.2.0",
  parameters: parseStrategyParameters({
    ...MEMECOIN_PAPER_CANDIDATE.parameters,
    entryGates: {
      ...MEMECOIN_PAPER_CANDIDATE.parameters.entryGates,
      paperLaunchMode: true,
      // Beide Schwellen stehen hier ausdruecklich. Sie entsprechen genau dem,
      // was vorher als `??`-Ersatzwert in der Pipeline stand — das Verhalten
      // aendert sich nicht, es ist nur erstmals lesbar. Besonders die 60
      // Sekunden: dieses Profil ist damit beim Datenalter STRENGER als „Sehr
      // offensiv" (120 s), und das war nirgends zu sehen.
      paperLaunchMinBuys: 3,
      paperLaunchMaxAgeSeconds: 60,
      minTokenAgeSeconds: 0,
      minDataCompleteness: 1,
      minFinalScore: 50,
      minMomentumScore: 50,
      maxMarketCapUsd: 20_000_000,
    },
    risk: {
      ...MEMECOIN_PAPER_CANDIDATE.parameters.risk,
      riskPerTradePct: 1,
      maxPositionPct: 5,
      maxPortfolioExposurePct: 20,
      maxDailyLossPct: 5,
      maxOpenPositions: 6,
      maxConsecutiveLosses: 4,
    },
  }),
} as const;

/** Higher-entry-frequency experiment. Independent paper ledger, never a live strategy. */
export const MEMECOIN_VERY_AGGRESSIVE_PAPER_CANDIDATE = {
  ...MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE,
  strategyId: "memecoin-very-active-paper",
  version: "1.0.0",
  parameters: parseStrategyParameters({
    ...MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE.parameters,
    entryGates: {
      ...MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE.parameters.entryGates,
      minFinalScore: 35, minSecurityScore: 50, minMomentumScore: 30,
      minLiquidityUsd: 5000, maxMarketCapUsd: 50000000,
      maxTop10HolderSharePct: 60,
      paperLaunchMinBuys: 1, paperLaunchMinBuyShare: 0.30,
      paperLaunchMaxAgeSeconds: 120,
    },
    risk: {
      ...MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE.parameters.risk,
      maxOpenPositions: 10, maxPortfolioExposurePct: 30,
      maxDailyLossPct: 10, maxConsecutiveLosses: 8,
      maxSlippageBps: 500, maxPriceImpactBps: 500,
      minExitCapacityRatio: 1, paperMaxRoundTripCostBps: 600,
    },
  }),
} as const;

export const PAPER_PROFILES = [
  { label: "Standard", candidate: MEMECOIN_PAPER_CANDIDATE },
  { label: "Offensiv", candidate: MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE },
  { label: "Sehr offensiv", candidate: MEMECOIN_VERY_AGGRESSIVE_PAPER_CANDIDATE },
] as const;
