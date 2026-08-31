import { BPS_DENOMINATOR, bps, money, mulDiv, type Bps, type Money } from "@sae/core";
import type { TakeProfitLevelConfig } from "@sae/config";
import type { ExecutionCostEstimate } from "@sae/simulation";

/**
 * Chance und Risiko eines geplanten Trades, in Geld statt in Prozentgefuehl.
 *
 * Drei Dinge macht dieses Modul anders als die uebliche „RR 1:3"-Angabe:
 *
 * 1. **Der Stop ist teurer als der Stop.** Zwischen Ausloesung und Fill liegt
 *    ein Kursabstand, dazu die Ausstiegskosten am verbliebenen Volumen. Ein
 *    „20-%-Stop" verliert mehr als 20 %.
 * 2. **Die Leiter wird einzeln gerechnet.** Jede Teilverkaufsstufe hat ihr
 *    eigenes Volumen und ihre eigenen Kosten. Ein Mittelwert ueber die Stufen
 *    verschiebt Kosten von den grossen zu den kleinen Tranchen.
 * 3. **Der Rest ohne Plan zaehlt nicht als Gewinn.** Was die Leiter nicht
 *    verkauft und kein Trailing Stop auffaengt, bleibt aus der Chance heraus.
 *
 * Und der Punkt, der am meisten missverstanden wird: **RR ist kein
 * Erwartungswert.** Es ist das Verhaeltnis zweier Szenarien, nicht deren
 * Wahrscheinlichkeit. Ein RR von 5:1 bei einer Trefferquote von 10 % ist ein
 * Verlustgeschaeft. Deshalb steht in `caveats` immer dieser Satz, und der
 * Erwartungswert kommt aus `composeRealisticEv`.
 */

export interface PlannedExitLadder {
  /** Stop-Abstand unter dem Einstieg. */
  readonly stopLossBps: Bps;
  readonly takeProfits: readonly TakeProfitLevelConfig[];
  /** Abstand des Trailing Stops vom Hoch. `null` = keiner. */
  readonly trailingStopBps: Bps | null;
}

export interface RiskRewardInputs {
  readonly entryNotional: Money;
  readonly ladder: PlannedExitLadder;
  readonly entryCost: ExecutionCostEstimate;
  readonly exitCostAt: (exitNotional: Money) => ExecutionCostEstimate;
  /**
   * Zusaetzlicher unguenstiger Kursabstand zwischen Stop-Ausloesung und Fill.
   *
   * Pflichtfeld ohne Default: bei einem Memecoin im Abverkauf ist genau das der
   * groesste Posten des Verlusts, und ein stillschweigender Nullwert wuerde
   * jeden Stop besser aussehen lassen, als er sich verhaelt.
   */
  readonly stopSlippageBps: Bps;
}

export interface LadderStepOutcome {
  readonly index: number;
  readonly triggerGainBps: Bps;
  readonly sellPortionBps: Bps;
  /** Anteil des Einstiegsvolumens, der hier verkauft wird. */
  readonly trancheCost: Money;
  readonly trancheProceeds: Money;
  readonly exitCost: Money;
  readonly netGain: Money;
}

export type RemainderTreatment =
  /** Die Leiter verkauft alles. */
  | "FULLY_SOLD"
  /** Rest laeuft in den Trailing Stop; bewertet mit dessen Untergrenze. */
  | "TRAILING_FLOOR"
  /** Rest hat keinen geplanten Ausstieg — zaehlt nicht zur Chance. */
  | "UNPLANNED";

export interface RiskRewardOutput {
  /** Nettogewinn, wenn der Plan vollstaendig aufgeht. */
  readonly upside: Money;
  readonly upsideFraction: number;
  /** Nettoverlust, wenn der Stop greift. Positiv dargestellt. */
  readonly downside: Money;
  readonly downsideFraction: number;
  /** Chance je Einheit Risiko. `null`, wenn kein Risiko bezifferbar ist. */
  readonly riskReward: number | null;
  readonly steps: readonly LadderStepOutcome[];
  readonly plannedSellPortionBps: number;
  readonly remainderTreatment: RemainderTreatment;
  readonly remainderNetGain: Money;
  readonly caveats: readonly string[];
}

const RR_IS_NOT_EV =
  "RR ist ein Szenarienverhaeltnis, kein Erwartungswert: ohne Trefferquote sagt es nichts ueber Profitabilitaet.";

/** Anteil `portionBps` eines Betrags. */
function portionOf(amount: Money, portionBps: number): Money {
  return money(
    mulDiv(amount.minor, BigInt(portionBps), BigInt(BPS_DENOMINATOR), "floor"),
    amount.currency,
  );
}

/** Betrag nach einer Kursveraenderung in Basispunkten (auch negativ). */
function afterGain(amount: Money, gainBps: number): Money {
  const factor = BigInt(BPS_DENOMINATOR) + BigInt(gainBps);
  if (factor <= 0n) return money(0n, amount.currency);
  return money(
    mulDiv(amount.minor, factor, BigInt(BPS_DENOMINATOR), "floor"),
    amount.currency,
  );
}

export function computeRiskReward(input: RiskRewardInputs): RiskRewardOutput {
  const currency = input.entryNotional.currency;
  const caveats: string[] = [RR_IS_NOT_EV];

  const sorted = [...input.ladder.takeProfits].sort((a, b) => a.index - b.index);
  const plannedSellPortionBps = sorted.reduce((sum, tp) => sum + tp.sellPortionBps, 0);

  const steps: LadderStepOutcome[] = sorted.map((tp) => {
    const trancheCost = portionOf(input.entryNotional, tp.sellPortionBps);
    const trancheProceeds = afterGain(trancheCost, tp.triggerGainBps);
    const exitCost = input.exitCostAt(trancheProceeds).total;
    return {
      index: tp.index,
      triggerGainBps: bps(tp.triggerGainBps),
      sellPortionBps: bps(tp.sellPortionBps),
      trancheCost,
      trancheProceeds,
      exitCost,
      netGain: money(
        trancheProceeds.minor - trancheCost.minor - exitCost.minor,
        currency,
      ),
    };
  });

  const remainderBps = BPS_DENOMINATOR - plannedSellPortionBps;
  const lastTrigger = sorted.length > 0 ? sorted[sorted.length - 1]!.triggerGainBps : 0;

  let remainderTreatment: RemainderTreatment;
  let remainderNetGain = money(0n, currency);

  if (remainderBps <= 0) {
    remainderTreatment = "FULLY_SOLD";
  } else if (input.ladder.trailingStopBps !== null) {
    // Untergrenze, kein Zielkurs: wer die letzte Stufe erreicht hat, faellt im
    // schlechtesten Fall genau den Trailing-Abstand unter dieses Hoch zurueck.
    // Der tatsaechliche Verlauf kann besser sein — schlechter nicht, sonst
    // haette eine fruehere Stufe schon verkauft.
    remainderTreatment = "TRAILING_FLOOR";
    const trancheCost = portionOf(input.entryNotional, remainderBps);
    const atPeak = afterGain(trancheCost, lastTrigger);
    const atFloor = money(
      mulDiv(
        atPeak.minor,
        BigInt(BPS_DENOMINATOR - input.ladder.trailingStopBps),
        BigInt(BPS_DENOMINATOR),
        "floor",
      ),
      currency,
    );
    const exitCost = input.exitCostAt(atFloor).total;
    remainderNetGain = money(atFloor.minor - trancheCost.minor - exitCost.minor, currency);
    caveats.push(
      `Rest (${(remainderBps / 100).toFixed(0)} %) bewertet als Trailing-Untergrenze ` +
        `bei +${(lastTrigger / 100).toFixed(0)} % minus ${(input.ladder.trailingStopBps / 100).toFixed(0)} %.`,
    );
  } else {
    remainderTreatment = "UNPLANNED";
    caveats.push(
      `${(remainderBps / 100).toFixed(0)} % der Position haben keinen geplanten Ausstieg ` +
        "und zaehlen nicht zur Chance.",
    );
  }

  const upsideMinor =
    steps.reduce((sum, s) => sum + s.netGain.minor, 0n) +
    remainderNetGain.minor -
    input.entryCost.total.minor;
  const upside = money(upsideMinor, currency);

  // Verlustseite: Stopabstand plus Slippage bis zum Fill, dazu beide
  // Ausfuehrungen.
  const adverseBps = input.ladder.stopLossBps + input.stopSlippageBps;
  const stopValue = afterGain(input.entryNotional, -adverseBps);
  const stopExitCost = input.exitCostAt(stopValue).total;
  const downsideMinor =
    input.entryNotional.minor - stopValue.minor + stopExitCost.minor + input.entryCost.total.minor;
  const downside = money(downsideMinor, currency);

  if (adverseBps >= BPS_DENOMINATOR) {
    caveats.push("Stopabstand plus Slippage erreicht 100 % — der Stop schuetzt nichts mehr.");
  }

  const base = Number(input.entryNotional.minor);
  const upsideFraction = base === 0 ? 0 : Number(upsideMinor) / base;
  const downsideFraction = base === 0 ? 0 : Number(downsideMinor) / base;

  if (upsideMinor <= 0n) {
    caveats.push("Der Plan ist auch im Erfolgsfall nicht profitabel — Kosten fressen die Leiter.");
  }

  return {
    upside,
    upsideFraction,
    downside,
    downsideFraction,
    riskReward: downsideMinor <= 0n ? null : Number(upsideMinor) / Number(downsideMinor),
    steps,
    plannedSellPortionBps,
    remainderTreatment,
    remainderNetGain,
    caveats,
  };
}
