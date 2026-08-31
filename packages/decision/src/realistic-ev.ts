import { money, mulDiv, type Bps, type Money } from "@sae/core";
import {
  estimateExecutionCosts,
  type CostModelInputs,
  type ExecutionCostEstimate,
} from "@sae/simulation";

import { estimateEv, type EvDetail, type OutcomeSample } from "./ev";

/**
 * Erwartungswert aus dem echten Kostenmodell.
 *
 * `estimateEv` nimmt die Kosten als fertigen Anteil entgegen. Das ist die
 * Stelle, an der Systeme sich selbst betruegen, und zwar auf drei Arten:
 *
 * 1. **Nur der Einstieg wird gerechnet.** Ein Trade hat zwei Ausfuehrungen. Wer
 *    nur die erste bucht, halbiert seine Kosten.
 * 2. **Das Ausstiegsvolumen ist ein anderes.** Bei +200 % ist die Verkaufsorder
 *    dreimal so gross wie der Einstieg — und die prozentualen Posten (DEX-Fee,
 *    Impact, Drift) wirken auf dieses groessere Volumen. Kosten mit "mal zwei"
 *    zu naehern unterschaetzt genau die Trades, die den Erwartungswert tragen.
 * 3. **Doppelt abgezogen.** Die realisierten Renditen aus `trade_outcomes` sind
 *    bereits netto. Zieht man davon nochmals Modellkosten ab, sinkt der EV mit
 *    jeder Verbesserung des Kostenmodells — ein Fehler, der wie Vorsicht
 *    aussieht.
 *
 * Deshalb ist `returnBasis` hier ein Pflichtfeld ohne Default. Es gibt keine
 * vertretbare Annahme; wer die Herkunft der Stichprobe nicht kennt, kann keinen
 * Erwartungswert daraus bilden.
 */

/** Ob die Renditen der Stichprobe vor oder nach Ausfuehrungskosten stehen. */
export type ReturnBasis = "GROSS" | "NET_OF_COSTS";

export interface RealisticEvInputs {
  readonly sample: readonly OutcomeSample[];
  readonly returnBasis: ReturnBasis;
  readonly minSampleSize: number;
  readonly entryNotional: Money;
  /** Kosten des Einstiegs, am Einstiegsvolumen geschaetzt. */
  readonly entryCost: ExecutionCostEstimate;
  /**
   * Kosten eines Ausstiegs bei gegebenem Ausstiegsvolumen.
   *
   * Bewusst eine Funktion und kein fester Wert: Preis-Impact haengt an der
   * Ordergroesse, und der Ausstieg aus einem Verzehnfacher ist eine andere
   * Order als der Einstieg. Der Aufrufer ist dafuer verantwortlich, den Impact
   * bei DIESER Groesse herzuleiten — `exitCostFactory` hilft dabei.
   */
  readonly exitCostAt: (exitNotional: Money) => ExecutionCostEstimate;
}

export interface CostComposition {
  readonly basis: ReturnBasis;
  /** Einstiegskosten als Anteil des Einstiegsvolumens. */
  readonly entryFraction: number;
  /** Ausstiegskosten im Gewinnfall, bezogen auf das EINSTIEGSvolumen. */
  readonly exitOnWinFraction: number;
  readonly exitOnLossFraction: number;
  /** Round Trip bei unveraendertem Kurs — die Huerde, die ein Trade nehmen muss. */
  readonly roundTripAtFlat: number;
  /** Wurden die Modellkosten vom EV abgezogen? Bei NET_OF_COSTS nicht. */
  readonly subtractedFromEv: boolean;
}

export interface RealisticEvDetail extends EvDetail {
  readonly costs: CostComposition;
  /**
   * Bruttorendite, ab der ein Trade nach allen Kosten bei null herauskommt.
   * `null`, wenn die Stichprobe fuer eine Aussage nicht reicht.
   */
  readonly breakevenReturn: number | null;
  /** Was an dieser Zahl nicht stimmt, im Klartext. Nie leer bei NET_OF_COSTS. */
  readonly caveats: readonly string[];
}

/** Anteil eines Betrags am Bezugsvolumen. 0, wenn kein Bezug existiert. */
function fractionOf(amount: Money, base: Money): number {
  if (base.minor === 0n) return 0;
  return Number(amount.minor) / Number(base.minor);
}

/** Volumen nach einer Rendite. Unter Totalverlust bleibt null, nicht negativ. */
export function notionalAfterReturn(base: Money, returnFraction: number): Money {
  const factor = Math.max(0, 1 + returnFraction);
  return money(
    mulDiv(base.minor, BigInt(Math.round(factor * 1_000_000)), 1_000_000n, "floor"),
    base.currency,
  );
}

export function composeRealisticEv(input: RealisticEvInputs): RealisticEvDetail {
  const entryFraction = fractionOf(input.entryCost.total, input.entryNotional);

  // Erst ohne Kosten schaetzen, um die reinen Renditen der beiden Aeste zu
  // bekommen — die bestimmen, wie gross die Ausstiegsorder ausfaellt.
  const bare = estimateEv({
    sample: input.sample,
    expectedCostFraction: 0,
    minSampleSize: input.minSampleSize,
  });

  const avgWin = bare.avgWin ?? 0;
  const avgLoss = bare.avgLoss ?? 0;

  const exitOnWin = input.exitCostAt(notionalAfterReturn(input.entryNotional, avgWin));
  const exitOnLoss = input.exitCostAt(notionalAfterReturn(input.entryNotional, -avgLoss));
  const exitAtFlat = input.exitCostAt(input.entryNotional);

  const exitOnWinFraction = fractionOf(exitOnWin.total, input.entryNotional);
  const exitOnLossFraction = fractionOf(exitOnLoss.total, input.entryNotional);
  const exitAtFlatFraction = fractionOf(exitAtFlat.total, input.entryNotional);

  const costs: CostComposition = {
    basis: input.returnBasis,
    entryFraction,
    exitOnWinFraction,
    exitOnLossFraction,
    roundTripAtFlat: entryFraction + exitAtFlatFraction,
    subtractedFromEv: input.returnBasis === "GROSS",
  };

  if (bare.estimate.kind === "UNKNOWN") {
    return {
      ...bare,
      costs,
      breakevenReturn: null,
      caveats: [
        `Stichprobe ${bare.estimate.sampleSize} < ${input.minSampleSize} — kein Erwartungswert.`,
      ],
    };
  }

  const caveats: string[] = [];

  if (input.returnBasis === "NET_OF_COSTS") {
    // Die Stichprobe traegt ihre eigenen, historischen Kosten. Diesen Trade
    // hier kann sie nicht kennen — bei duennem Buch koennen seine Kosten ein
    // Vielfaches betragen. Der EV bleibt gueltig, ist aber blind fuer die
    // aktuelle Ausfuehrungslage; dafuer gibt es das Kostengate, nicht den EV.
    caveats.push(
      "Renditen sind bereits netto: der EV enthaelt historische, nicht die " +
        `aktuellen Kosten (Modell: ${(costs.roundTripAtFlat * 100).toFixed(2)} % Round Trip).`,
    );
  }

  const evAt = (p: number): number =>
    input.returnBasis === "NET_OF_COSTS"
      ? p * avgWin - (1 - p) * avgLoss
      : p * (avgWin - exitOnWinFraction) - (1 - p) * (avgLoss + exitOnLossFraction) - entryFraction;

  const winRate = bare.winRate ?? 0;
  const lowerBound = bare.winRateLowerBound ?? 0;

  const pointEv = evAt(winRate);
  const conservativeEv = evAt(lowerBound);

  // Breakeven: R − k·(1 + R) − entry = 0, mit k als Ausstiegskostensatz.
  // Aufgeloest R = (k + entry) / (1 − k). k >= 1 hiesse, der Ausstieg kostet
  // mehr als er einbringt — dann gibt es keinen Kurs, der das rettet.
  const k = exitAtFlatFraction;
  const breakevenReturn = k >= 1 ? null : (k + entryFraction) / (1 - k);
  if (breakevenReturn === null) {
    caveats.push("Ausstiegskosten erreichen das Volumen — kein Breakeven definierbar.");
  }

  if (input.returnBasis === "GROSS" && conservativeEv <= 0 && pointEv > 0) {
    caveats.push(
      "Positiv nur in der Punktschaetzung; an der unteren Konfidenzgrenze nicht.",
    );
  }

  return {
    estimate: {
      kind: "ESTIMATED",
      evPerUnit: conservativeEv,
      evIntervalConfidence: bare.estimate.evIntervalConfidence,
      sampleSize: bare.estimate.sampleSize,
    },
    pointEv,
    conservativeEv,
    winRate: bare.winRate,
    winRateLowerBound: bare.winRateLowerBound,
    avgWin: bare.avgWin,
    avgLoss: bare.avgLoss,
    costs,
    breakevenReturn,
    caveats,
  };
}

/**
 * Baut die Ausstiegskostenfunktion aus dem Kostenmodell.
 *
 * `impactAt` ist Pflicht und bekommt das Volumen: der Preis-Impact ist der
 * einzige Posten, der nicht linear mit der Ordergroesse skaliert, und ihn vom
 * Einstieg zu uebernehmen ist genau der Fehler, der grosse Gewinner zu teuer
 * aussehen laesst — oder, schlimmer, zu billig.
 */
export function exitCostFactory(
  base: Omit<CostModelInputs, "notional" | "priceImpactBps">,
  impactAt: (exitNotional: Money) => Bps,
): (exitNotional: Money) => ExecutionCostEstimate {
  return (exitNotional: Money) =>
    estimateExecutionCosts({
      ...base,
      notional: exitNotional,
      priceImpactBps: impactAt(exitNotional),
    });
}
