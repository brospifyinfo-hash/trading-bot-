import type { Bps } from "@sae/core";
import { maxAmountWithinImpact } from "./price-impact";

/**
 * Ausstiegsfaehigkeit.
 *
 * Der Check, den die meisten Bots auslassen: ein Token kann jeden Score der Welt
 * haben und trotzdem eine Falle sein, wenn die geplante Position nicht wieder
 * herausgeht. Er laeuft VOR dem Einstieg, nicht erst beim Exit.
 */

export interface ExitCapacityAssessment {
  /** Menge, die innerhalb der Impact-Obergrenze verkaeuflich waere. */
  readonly sellableAmount: bigint;
  readonly positionAmount: bigint;
  /**
   * sellableAmount / positionAmount. Ein Wert von 3 heisst: die dreifache
   * Positionsgroesse ginge noch innerhalb der Grenze heraus.
   */
  readonly capacityRatio: number;
  readonly sufficient: boolean;
}

export function assessExitCapacity(params: {
  /** Token-Reserve des Pools, in den verkauft wird. */
  readonly poolTokenReserve: bigint;
  readonly positionAmount: bigint;
  readonly maxImpactBps: Bps;
  /** Geforderter Sicherheitsfaktor, z. B. 3 = dreifache Position muss passen. */
  readonly minCapacityRatio: number;
}): ExitCapacityAssessment {
  const sellableAmount = maxAmountWithinImpact(params.poolTokenReserve, params.maxImpactBps);

  if (params.positionAmount <= 0n) {
    return {
      sellableAmount,
      positionAmount: params.positionAmount,
      capacityRatio: Number.POSITIVE_INFINITY,
      sufficient: true,
    };
  }

  // Skaliert vor der Umwandlung in `number`, damit grosse bigints nicht
  // stillschweigend an Praezision verlieren.
  const scaled = (sellableAmount * 10_000n) / params.positionAmount;
  const capacityRatio = Number(scaled) / 10_000;

  return {
    sellableAmount,
    positionAmount: params.positionAmount,
    capacityRatio,
    sufficient: capacityRatio >= params.minCapacityRatio,
  };
}
