import { bps, type Bps } from "@sae/core";
import { assessExitCapacity } from "@sae/simulation";

/**
 * Notausstieg.
 *
 * Wichtigster Punkt: er verkauft NICHT blind. Bei einem Liquiditaetsabzug ist
 * der Reflex, sofort alles auf den Markt zu werfen — und genau das realisiert
 * den maximalen Schaden, weil die verbliebene Tiefe nicht reicht. Geprueft wird
 * deshalb zuerst, was ueberhaupt herausgeht, und dann in Stuecken verkauft.
 */

export type EmergencyPlan =
  | {
      readonly kind: "SELL_FULL";
      readonly amount: bigint;
      readonly expectedImpactBps: Bps;
    }
  | {
      /** Aufteilung in Tranchen, weil die Tiefe fuer alles auf einmal nicht reicht. */
      readonly kind: "SELL_IN_TRANCHES";
      readonly trancheAmount: bigint;
      readonly trancheCount: number;
      readonly expectedImpactBps: Bps;
    }
  | {
      /** Kein sinnvoller Ausstieg moeglich. Menschliche Entscheidung noetig. */
      readonly kind: "NO_VIABLE_EXIT";
      readonly reason: string;
    };

export function planEmergencyExit(input: {
  readonly positionAmount: bigint;
  readonly poolTokenReserve: bigint;
  /** Impact, den wir im Notfall hinzunehmen bereit sind — hoeher als im Normalbetrieb. */
  readonly acceptableImpactBps: Bps;
  /** Ab welchem Impact ein Verkauf mehr schadet als nuetzt. */
  readonly maxTolerableImpactBps: Bps;
  readonly maxTranches: number;
}): EmergencyPlan {
  if (input.positionAmount <= 0n) {
    return { kind: "NO_VIABLE_EXIT", reason: "Keine Position vorhanden" };
  }
  if (input.poolTokenReserve <= 0n) {
    return { kind: "NO_VIABLE_EXIT", reason: "Kein Pool mit Restliquiditaet gefunden" };
  }

  const full = assessExitCapacity({
    poolTokenReserve: input.poolTokenReserve,
    positionAmount: input.positionAmount,
    maxImpactBps: input.acceptableImpactBps,
    minCapacityRatio: 1,
  });

  if (full.sufficient) {
    return {
      kind: "SELL_FULL",
      amount: input.positionAmount,
      expectedImpactBps: input.acceptableImpactBps,
    };
  }

  // Tranchen so bemessen, dass jede einzelne innerhalb der Grenze bleibt.
  const perTranche = full.sellableAmount;
  if (perTranche <= 0n) {
    return {
      kind: "NO_VIABLE_EXIT",
      reason: "Selbst die kleinste Tranche ueberschreitet die Impact-Grenze",
    };
  }

  const needed = Number((input.positionAmount + perTranche - 1n) / perTranche);
  if (needed <= input.maxTranches) {
    return {
      kind: "SELL_IN_TRANCHES",
      trancheAmount: perTranche,
      trancheCount: needed,
      expectedImpactBps: input.acceptableImpactBps,
    };
  }

  // Zu viele Tranchen beim bevorzugten Impact. Bevor aufgegeben wird, dieselbe
  // Rechnung mit der hoechsten noch vertretbaren Impact-Grenze: groessere
  // Tranchen kosten mehr pro Stueck, brauchen aber weniger Transaktionen — und
  // jede zusaetzliche Transaktion ist im Notfall selbst ein Risiko, weil der
  // Kurs zwischen ihnen weiterlaeuft.
  const stretchedFull = assessExitCapacity({
    poolTokenReserve: input.poolTokenReserve,
    positionAmount: input.positionAmount,
    maxImpactBps: input.maxTolerableImpactBps,
    minCapacityRatio: 1,
  });
  if (stretchedFull.sufficient) {
    return {
      kind: "SELL_FULL",
      amount: input.positionAmount,
      expectedImpactBps: input.maxTolerableImpactBps,
    };
  }

  const stretchedTranche = stretchedFull.sellableAmount;
  if (stretchedTranche > 0n) {
    const stretchedNeeded = Number(
      (input.positionAmount + stretchedTranche - 1n) / stretchedTranche,
    );
    if (stretchedNeeded <= input.maxTranches) {
      return {
        kind: "SELL_IN_TRANCHES",
        trancheAmount: stretchedTranche,
        trancheCount: stretchedNeeded,
        expectedImpactBps: input.maxTolerableImpactBps,
      };
    }
  }

  // Die Position ist in dieser Liquiditaet nicht aufloesbar. Das ist eine
  // Feststellung, keine Handlungsanweisung — ein Mensch muss entscheiden.
  return {
    kind: "NO_VIABLE_EXIT",
    reason: `Position braucht ${needed} Tranchen, erlaubt sind ${input.maxTranches}`,
  };
}

export const DEFAULT_EMERGENCY_IMPACT_BPS = bps(500);
export const MAX_TOLERABLE_EMERGENCY_IMPACT_BPS = bps(1_500);
