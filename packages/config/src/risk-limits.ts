/**
 * Harte Obergrenzen.
 *
 * Diese Werte sind bewusst NICHT konfigurierbar. Sie sind die Notbremse gegen eine
 * Fehlkonfiguration im Dashboard — eine Strategieversion darf sie unterschreiten,
 * aber niemals ueberschreiten. Eine Aenderung hier ist eine Codeaenderung und
 * durchlaeuft Review, Test und Deploy.
 */
export const HARD_LIMITS = {
  /** Nie mehr als 10 % des Portfolios in einer einzigen Position. */
  maxPositionPctOfPortfolio: 10,
  /** Nie mehr als 40 % des Portfolios gleichzeitig im Markt. */
  maxPortfolioExposurePct: 40,
  /** Nie mehr als 20 % Tagesverlust, bevor der Auto-Modus zwangspausiert. */
  maxDailyLossPct: 20,
  /** Nie mehr als 20 offene Positionen gleichzeitig. */
  maxOpenPositions: 20,
  /** Nie mehr als 10 % Slippage-Toleranz auf einen Einstieg. */
  maxSlippageBps: 1_000,
  /** Nie mehr als 5 % erwarteter Price Impact. */
  maxPriceImpactBps: 500,
  /** Nie mehr als 5 % Risiko des Portfolios pro einzelnem Trade. */
  maxRiskPerTradePct: 5,
  /** Aelter als das: Daten sind unbrauchbar fuer eine Einstiegsentscheidung. */
  maxDataAgeMs: 120_000,
} as const;

export type HardLimits = typeof HARD_LIMITS;
