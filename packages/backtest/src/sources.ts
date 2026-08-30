import type { TokenId } from "@sae/core";
import type { FeatureVector } from "@sae/scoring";
import type { PositionMarketState } from "@sae/trading";

/**
 * Datenquellen des Backtests.
 *
 * Beide Methoden verlangen `asOf` und liefern ausschliesslich, was zu diesem
 * Zeitpunkt bekannt war. In Produktion sind sie ueber den `PitReader`
 * implementiert, im Test ueber Fixtures — in beiden Faellen gilt dieselbe
 * Einschraenkung, weil es ohne `asOf` gar keine Methode gibt.
 *
 * Der Harness ruft sie AUSSCHLIESSLICH mit seiner eigenen Simulationszeit auf.
 * Ein Test haelt genau das fest.
 */
export interface BacktestDataSource {
  /** Tokens, die zu diesem Zeitpunkt ueberhaupt bekannt waren. */
  universeAt(asOf: Date): Promise<readonly TokenId[]>;

  /** Feature-Vektor eines Tokens zu diesem Zeitpunkt, oder null. */
  featuresAt(tokenId: TokenId, asOf: Date): Promise<FeatureVector | null>;

  /** Marktzustand einer offenen Position, relativ zu ihrem Einstand. */
  positionMarketAt(
    tokenId: TokenId,
    entryPriceUsd: number,
    entryLiquidityUsd: number,
    highWaterRatio: number,
    holdingSeconds: number,
    asOf: Date,
  ): Promise<PositionMarketState | null>;

  /** Ausgabemenge und Impact fuer einen simulierten Swap zu diesem Zeitpunkt. */
  quoteAt(
    tokenId: TokenId,
    notionalMinor: bigint,
    asOf: Date,
  ): Promise<{ outAmount: bigint; priceImpactBps: number } | null>;
}
