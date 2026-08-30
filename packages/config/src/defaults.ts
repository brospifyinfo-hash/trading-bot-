import type { StrategyParameters } from "./strategy-schema";

/**
 * Betriebsmodus.
 *
 * `paper` und `live: false` sind hier fest verdrahtet. Live-Trading wird
 * ausschliesslich zur Laufzeit, bewusst und mit 2FA aktiviert — nie durch eine
 * Konfigurationsdatei und nie als Default.
 */
export interface BotMode {
  readonly execution: "paper" | "live";
  readonly decision: "manual" | "auto";
  readonly liveTradingEnabled: boolean;
}

export const DEFAULT_BOT_MODE: BotMode = {
  execution: "paper",
  decision: "manual",
  liveTradingEnabled: false,
};

/**
 * Konservative Startparameter.
 *
 * Sie sind ausdruecklich NICHT validiert und nicht als profitabel behauptet — es
 * sind plausible Ausgangswerte, die Backtest und Paper Trading erst pruefen muessen.
 * Die Liquiditaetsschwelle ist an einem kleinen Portfolio (~1.000 €, Position 1–5 %)
 * ausgerichtet: bei groesserem Kapital muss sie steigen, sonst bindet der
 * Exit-Kapazitaets-Check.
 */
export const DEFAULT_STRATEGY_PARAMETERS: StrategyParameters = {
  entryGates: {
    minFinalScore: 75,
    minSecurityScore: 80,
    minLiquidityUsd: 25_000,
    maxMarketCapUsd: 5_000_000,
    minTokenAgeSeconds: 300,
    minSmartMoneyScore: 0,
    minSocialScore: 0,
    minMomentumScore: 60,
    maxTop10HolderSharePct: 35,
    minDataCompleteness: 0.7,
    minEvSampleSize: 100,
    minEvConfidence: 0.6,
  },
  risk: {
    riskPerTradePct: 1,
    maxPositionPct: 3,
    maxPortfolioExposurePct: 15,
    maxDailyLossPct: 5,
    maxOpenPositions: 5,
    maxConsecutiveLosses: 4,
    maxSlippageBps: 300,
    maxPriceImpactBps: 200,
    minExitCapacityRatio: 3,
  },
  exit: {
    stopLossBps: 2_000,
    takeProfits: [
      { index: 1, triggerGainBps: 2_500, sellPortionBps: 2_000 },
      { index: 2, triggerGainBps: 5_000, sellPortionBps: 2_000 },
      { index: 3, triggerGainBps: 10_000, sellPortionBps: 2_500 },
      { index: 4, triggerGainBps: 20_000, sellPortionBps: 2_500 },
    ],
    trailingStopBps: 1_500,
    dynamicExitRules: [],
    maxHoldingTimeSeconds: 86_400,
  },
  watchlistRescoreIntervalSeconds: 60,
  alertCooldownSeconds: 1_800,
  alertScoreJumpThreshold: 8,
};

/**
 * Bedingungen fuer die Freigabe von Live-Trading.
 *
 * Das System prueft sie; die Freigabe selbst trifft ein Mensch. Erfuellte
 * Bedingungen sind eine Voraussetzung, keine Empfehlung.
 */
export const CALIBRATION_GATE = {
  minPaperTradesPerStrategyVersion: 100,
  requiresOutOfSampleResults: true,
  requiresTwoFactorStepUp: true,
} as const;
