import { money, mulDiv, type Money } from "@sae/core";
import type { StrategyParameters } from "@sae/config";

/**
 * Portfolio-Ebene.
 *
 * Einzelne Positionen koennen jede fuer sich vertretbar sein und zusammen
 * trotzdem zu viel. Der Bot muss deshalb jederzeit wissen, wie viel insgesamt
 * im Markt ist — nicht erst, wenn es zu spaet ist.
 */

export interface OpenPositionSummary {
  readonly tokenId: string;
  readonly notional: Money;
}

export interface PortfolioState {
  readonly value: Money;
  readonly openPositions: readonly OpenPositionSummary[];
  /** Realisierter Gewinn oder Verlust im laufenden Tagesfenster. */
  readonly realizedTodayPnl: Money;
  readonly consecutiveLosses: number;
}

export interface ExposureCheck {
  readonly currentExposure: Money;
  readonly exposureAfterTrade: Money;
  readonly exposurePctAfterTrade: number;
  readonly openPositionCount: number;
  readonly withinLimits: boolean;
  readonly violations: readonly string[];
}

export function checkExposure(
  state: PortfolioState,
  plannedNotional: Money,
  parameters: StrategyParameters,
): ExposureCheck {
  const currency = state.value.currency;
  const currentMinor = state.openPositions.reduce((sum, p) => {
    if (p.notional.currency !== currency) {
      throw new TypeError("Position in anderer Waehrung als das Portfolio");
    }
    return sum + p.notional.minor;
  }, 0n);

  const afterMinor = currentMinor + plannedNotional.minor;
  const exposurePctAfterTrade =
    state.value.minor === 0n
      ? Number.POSITIVE_INFINITY
      : Number(mulDiv(afterMinor, 1_000_000n, state.value.minor, "floor")) / 10_000;

  const violations: string[] = [];
  if (exposurePctAfterTrade > parameters.risk.maxPortfolioExposurePct) {
    violations.push("PORTFOLIO_EXPOSURE_LIMIT");
  }
  if (state.openPositions.length >= parameters.risk.maxOpenPositions) {
    violations.push("MAX_OPEN_POSITIONS_REACHED");
  }

  return {
    currentExposure: money(currentMinor, currency),
    exposureAfterTrade: money(afterMinor, currency),
    exposurePctAfterTrade,
    openPositionCount: state.openPositions.length,
    withinLimits: violations.length === 0,
    violations,
  };
}

/** Tagesverlust in Prozent des Portfoliowerts. Positiv bedeutet Verlust. */
export function dailyLossPct(state: PortfolioState): number {
  if (state.value.minor === 0n) return 0;
  if (state.realizedTodayPnl.minor >= 0n) return 0;
  return (
    Number(mulDiv(-state.realizedTodayPnl.minor, 1_000_000n, state.value.minor, "ceil")) / 10_000
  );
}
