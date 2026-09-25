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
  version: "1.1.0",
  parameters: parseStrategyParameters({
    ...MEMECOIN_PAPER_CANDIDATE.parameters,
    entryGates: {
      ...MEMECOIN_PAPER_CANDIDATE.parameters.entryGates,
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

export const PAPER_PROFILES = [
  { label: "Standard", candidate: MEMECOIN_PAPER_CANDIDATE },
  { label: "Offensiv", candidate: MEMECOIN_AGGRESSIVE_PAPER_CANDIDATE },
] as const;
