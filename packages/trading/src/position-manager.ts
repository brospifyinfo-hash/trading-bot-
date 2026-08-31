import type { Bps } from "@sae/core";
import {
  ALL_EXIT_RULES,
  type ExitAction,
  type ExitRule,
  type ExitRuleContext,
  type ExitSignal,
  type PositionMarketState,
} from "./exit-rules";
import type { ExitExecutionState } from "./execution-failure-exit";

/**
 * Positionsverwaltung.
 *
 * Reine Funktion: gleicher Zustand, gleiche Entscheidung. Sie fuehrt NICHTS aus,
 * sondern gibt zurueck, was zu tun waere. Das trennt die Regel von ihrer
 * Ausfuehrung — und macht sie im Backtest millionenfach auswertbar, ohne dass
 * irgendwo eine Transaktion entsteht.
 */

export interface TakeProfitLevelState {
  readonly index: number;
  readonly triggerGainBps: Bps;
  readonly sellPortionBps: Bps;
  readonly hit: boolean;
}

export interface PositionState {
  readonly positionId: string;
  /** Zustand der Ausfuehrungsversuche. `null` = keine Fehlschlaege bekannt. */
  readonly execution?: ExitExecutionState | null;
  /** Verbleibender Anteil der Ursprungsposition in Basispunkten. 10000 = voll. */
  readonly remainingBps: Bps;
  readonly stopLossBps: Bps;
  readonly trailingStopBps: Bps | null;
  readonly takeProfits: readonly TakeProfitLevelState[];
  readonly maxHoldingSeconds: number | null;
}

export interface PositionDecision {
  readonly actions: readonly ExitAction[];
  readonly signals: readonly ExitSignal[];
  /** Trailing Stop nach Anwendung der Regeln — null, wenn nicht aktiv. */
  readonly effectiveTrailingBps: Bps | null;
}

const asBps = (n: number): Bps => n as Bps;

/**
 * Bewertet eine offene Position.
 *
 * Rangfolge, und zwar in dieser Reihenfolge:
 *   1. Sofortausstieg aus Risikogruenden — schlaegt alles andere
 *   2. Stop Loss
 *   3. Trailing Stop (mit den Anpassungen der dynamischen Regeln)
 *   4. Take-Profit-Stufen
 *
 * Der Stop steht bewusst VOR den Take-Profit-Stufen: faellt der Kurs in einem
 * Tick unter den Stop und ueberschreitet gleichzeitig eine TP-Schwelle, ist der
 * Verlustschutz das Dringendere.
 */
export function evaluatePosition(
  position: PositionState,
  market: PositionMarketState,
  options: { readonly enabledRuleIds?: readonly string[]; readonly rules?: readonly ExitRule[] } = {},
): PositionDecision {
  const rules = options.rules ?? ALL_EXIT_RULES;
  const enabled =
    options.enabledRuleIds === undefined
      ? rules
      : rules.filter((r) => options.enabledRuleIds!.includes(r.id));

  const ctx: ExitRuleContext = {
    market,
    currentTrailingBps: position.trailingStopBps ?? asBps(0),
    maxHoldingSeconds: position.maxHoldingSeconds,
    execution: position.execution ?? null,
  };

  const signals: ExitSignal[] = [];
  for (const rule of enabled) {
    const signal = rule.evaluate(ctx);
    if (signal !== null) signals.push(signal);
  }

  // 1. Sofortausstieg schlaegt alles.
  const immediate = signals.find(
    (s) => s.action.kind === "EXIT_ALL" && s.action.urgency === "IMMEDIATE",
  );
  if (immediate) {
    return {
      actions: [immediate.action],
      signals,
      effectiveTrailingBps: position.trailingStopBps,
    };
  }

  // Trailing Stop aus den dynamischen Anpassungen ableiten. Bei mehreren
  // Vorschlaegen gewinnt der ENGSTE — im Zweifel schuetzen, nicht hoffen.
  let effectiveTrailingBps = position.trailingStopBps;
  for (const signal of signals) {
    if (signal.action.kind === "TIGHTEN_TRAILING") {
      effectiveTrailingBps =
        effectiveTrailingBps === null
          ? signal.action.newTrailingBps
          : asBps(Math.min(effectiveTrailingBps, signal.action.newTrailingBps));
    }
  }
  // Lockern nur, wenn KEINE Regel gleichzeitig verengen will.
  const wantsTightening = signals.some((s) => s.action.kind === "TIGHTEN_TRAILING");
  if (!wantsTightening) {
    for (const signal of signals) {
      if (signal.action.kind === "LOOSEN_TRAILING") {
        effectiveTrailingBps = signal.action.newTrailingBps;
      }
    }
  }

  const actions: ExitAction[] = [];

  // 2. Stop Loss.
  const stopRatio = 1 - position.stopLossBps / 10_000;
  if (market.priceRatio <= stopRatio) {
    return {
      actions: [{ kind: "EXIT_ALL", urgency: "NORMAL" }],
      signals,
      effectiveTrailingBps,
    };
  }

  // 3. Trailing Stop, gemessen am Hoechststand.
  if (effectiveTrailingBps !== null && market.highWaterRatio > 1) {
    const trailRatio = market.highWaterRatio * (1 - effectiveTrailingBps / 10_000);
    if (market.priceRatio <= trailRatio) {
      return {
        actions: [{ kind: "EXIT_ALL", urgency: "NORMAL" }],
        signals,
        effectiveTrailingBps,
      };
    }
  }

  // 4. Take-Profit-Stufen. Jede loest hoechstens einmal aus, und nur solange
  //    ueberhaupt noch etwas uebrig ist.
  let remaining = position.remainingBps as number;
  for (const level of [...position.takeProfits].sort((a, b) => a.index - b.index)) {
    if (level.hit) continue;
    const trigger = 1 + level.triggerGainBps / 10_000;
    if (market.priceRatio < trigger) continue;
    const portion = Math.min(level.sellPortionBps, remaining);
    if (portion <= 0) continue;
    actions.push({ kind: "SELL_PORTION", portionBps: asBps(portion), levelIndex: level.index });
    remaining -= portion;
  }

  // 5. Zeitgesteuerter Ausstieg, wenn nichts anderes gegriffen hat.
  if (actions.length === 0) {
    const timed = signals.find(
      (s) => s.action.kind === "EXIT_ALL" && s.action.urgency === "NORMAL",
    );
    if (timed) return { actions: [timed.action], signals, effectiveTrailingBps };
  }

  return {
    actions: actions.length > 0 ? actions : [{ kind: "HOLD" }],
    signals,
    effectiveTrailingBps,
  };
}
