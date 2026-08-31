import type { Bps } from "@sae/core";

import { EXECUTION_FAILURE, type ExitExecutionState } from "./execution-failure-exit";

/**
 * Adaptive Exit-Regeln.
 *
 * Jede Regel hat eine ID und ist einzeln abschaltbar — nicht aus Bequemlichkeit,
 * sondern damit sich im Backtest messen laesst, was jede einzelne beitraegt. Ein
 * Regelsatz, den man nur als Ganzes an- und ausschalten kann, ist nicht
 * auswertbar: man weiss am Ende nicht, welche Regel geholfen und welche
 * geschadet hat.
 *
 * Kein LLM und kein Modell entscheidet hier. Die Regeln sind deterministisch,
 * lesbar und einzeln testbar.
 */

export type ExitAction =
  /** Nichts tun. */
  | { readonly kind: "HOLD" }
  /** Trailing Stop enger ziehen — Momentum laesst nach. */
  | { readonly kind: "TIGHTEN_TRAILING"; readonly newTrailingBps: Bps }
  /** Trailing Stop lockern — Momentum haelt an, Runner laufen lassen. */
  | { readonly kind: "LOOSEN_TRAILING"; readonly newTrailingBps: Bps }
  /** Teilverkauf ausloesen. */
  | { readonly kind: "SELL_PORTION"; readonly portionBps: Bps; readonly levelIndex: number }
  /** Vollstaendiger Ausstieg. */
  | { readonly kind: "EXIT_ALL"; readonly urgency: "NORMAL" | "IMMEDIATE" };

export interface ExitSignal {
  readonly ruleId: string;
  readonly action: ExitAction;
  readonly detail: string;
}

/** Marktzustand einer offenen Position zum Bewertungszeitpunkt. */
export interface PositionMarketState {
  /** Aktueller Preis relativ zum gewichteten Einstand, z. B. 1.35 = +35 %. */
  readonly priceRatio: number;
  /** Hoechster bisher erreichter Preisfaktor. */
  readonly highWaterRatio: number;
  /** Volumenbeschleunigung, > 1 heisst wachsend. */
  readonly volumeAcceleration: number | null;
  /** Anteil Kaeufe an allen Transaktionen im Fenster, 0..1. */
  readonly buyRatio: number | null;
  /** Liquiditaet relativ zum Einstiegszeitpunkt, 1 = unveraendert. */
  readonly liquidityRatio: number | null;
  readonly smartMoneySellers: number | null;
  readonly devSold: boolean | null;
  readonly securityDowngraded: boolean;
  readonly holdingSeconds: number;
  /**
   * Erwarteter Price Impact eines Ausstiegs in dieser Groesse, zum
   * Bewertungszeitpunkt. Wird von den Regeln nicht gelesen, aber vom Backtest
   * und vom Positions-Worker fuer die Ausstiegskosten gebraucht.
   */
  readonly priceImpactBps?: number;
}

export interface ExitRuleContext {
  readonly market: PositionMarketState;
  readonly currentTrailingBps: Bps;
  readonly maxHoldingSeconds: number | null;
  /**
   * Zustand der Ausfuehrungsversuche fuer diese Position.
   *
   * `null` heisst „kein Fehlschlag bekannt" — und nicht „egal": die
   * Execution-Failure-Regel unterscheidet marktseitige von betrieblichen
   * Fehlern, und diese Unterscheidung braucht die Historie.
   */
  readonly execution: ExitExecutionState | null;
}

export interface ExitRule {
  readonly id: string;
  readonly description: string;
  /** `null` heisst: diese Regel hat zu diesem Zeitpunkt nichts zu sagen. */
  evaluate(ctx: ExitRuleContext): ExitSignal | null;
}

const asBps = (n: number): Bps => n as Bps;

/**
 * Risiko-Stops.
 *
 * Sie greifen unabhaengig vom Preis. Ein Token kann im Plus stehen und trotzdem
 * ein Ausstiegsgrund vorliegen — Liquiditaetsabzug oder ein verkaufender
 * Entwickler sind Ereignisse, keine Kursbewegungen.
 */
export const LIQUIDITY_COLLAPSE: ExitRule = {
  id: "RISK_LIQUIDITY_COLLAPSE",
  description: "Liquiditaet faellt deutlich unter den Stand bei Einstieg",
  evaluate(ctx) {
    const ratio = ctx.market.liquidityRatio;
    if (ratio === null || ratio >= 0.5) return null;
    return {
      ruleId: this.id,
      action: { kind: "EXIT_ALL", urgency: "IMMEDIATE" },
      detail: `Liquiditaet auf ${(ratio * 100).toFixed(0)} % des Einstiegsstands`,
    };
  },
};

export const DEV_SOLD: ExitRule = {
  id: "RISK_DEV_SOLD",
  description: "Entwickler-Wallet verkauft",
  evaluate(ctx) {
    if (ctx.market.devSold !== true) return null;
    return {
      ruleId: this.id,
      action: { kind: "EXIT_ALL", urgency: "IMMEDIATE" },
      detail: "Entwickler-Wallet hat verkauft",
    };
  },
};

export const SECURITY_DOWNGRADE: ExitRule = {
  id: "RISK_SECURITY_DOWNGRADE",
  description: "Sicherheitsbewertung hat sich nach dem Einstieg verschlechtert",
  evaluate(ctx) {
    if (!ctx.market.securityDowngraded) return null;
    return {
      ruleId: this.id,
      action: { kind: "EXIT_ALL", urgency: "IMMEDIATE" },
      detail: "Sicherheitsstatus verschlechtert",
    };
  },
};

export const SMART_MONEY_EXIT: ExitRule = {
  id: "RISK_SMART_MONEY_EXIT",
  description: "Mehrere qualifizierte Wallets steigen aus",
  evaluate(ctx) {
    const sellers = ctx.market.smartMoneySellers;
    if (sellers === null || sellers < 3) return null;
    // Kein Sofortausstieg: anders als ein Liquiditaetsabzug ist das ein Signal,
    // keine Notlage. Der Trailing Stop wird eng gezogen, damit ein weiterlaufender
    // Kurs noch mitgenommen wird.
    return {
      ruleId: this.id,
      action: { kind: "TIGHTEN_TRAILING", newTrailingBps: asBps(500) },
      detail: `${sellers} qualifizierte Wallets verkaufen`,
    };
  },
};

/**
 * Momentum-Regeln.
 *
 * Der Kern des dynamischen Exits: nicht nur der Preis entscheidet, sondern ob
 * die Bewegung noch getragen wird.
 */
export const MOMENTUM_COLLAPSE: ExitRule = {
  id: "DYN_MOMENTUM_COLLAPSE",
  description: "Volumen bricht ein, waehrend die Position im Gewinn steht",
  evaluate(ctx) {
    const accel = ctx.market.volumeAcceleration;
    if (accel === null || accel >= 0.4) return null;
    if (ctx.market.priceRatio <= 1) return null;
    return {
      ruleId: this.id,
      action: { kind: "TIGHTEN_TRAILING", newTrailingBps: asBps(400) },
      detail: `Volumen auf ${(accel * 100).toFixed(0)} % gefallen`,
    };
  },
};

export const SELL_PRESSURE: ExitRule = {
  id: "DYN_SELL_PRESSURE",
  description: "Verkaeufe dominieren deutlich",
  evaluate(ctx) {
    const ratio = ctx.market.buyRatio;
    if (ratio === null || ratio >= 0.3) return null;
    return {
      ruleId: this.id,
      action: { kind: "TIGHTEN_TRAILING", newTrailingBps: asBps(600) },
      detail: `Nur ${(ratio * 100).toFixed(0)} % Kaeufe`,
    };
  },
};

export const STRONG_RUNNER: ExitRule = {
  id: "DYN_STRONG_RUNNER",
  description: "Momentum haelt an — Runner laufen lassen",
  evaluate(ctx) {
    const accel = ctx.market.volumeAcceleration;
    const buyRatio = ctx.market.buyRatio;
    if (accel === null || buyRatio === null) return null;
    if (accel < 2 || buyRatio < 0.65 || ctx.market.priceRatio < 1.5) return null;
    // Nur lockern, nie ueber eine Obergrenze hinaus: ein zu weiter Trailing Stop
    // gibt am Ende den ganzen Gewinn zurueck.
    const loosened = Math.min(3_000, ctx.currentTrailingBps * 2);
    if (loosened <= ctx.currentTrailingBps) return null;
    return {
      ruleId: this.id,
      action: { kind: "LOOSEN_TRAILING", newTrailingBps: asBps(loosened) },
      detail: `Volumen ${accel.toFixed(1)}-fach bei ${(buyRatio * 100).toFixed(0)} % Kaeufen`,
    };
  },
};

export const MAX_HOLDING_TIME: ExitRule = {
  id: "DYN_MAX_HOLDING_TIME",
  description: "Maximale Haltedauer erreicht",
  evaluate(ctx) {
    if (ctx.maxHoldingSeconds === null) return null;
    if (ctx.market.holdingSeconds < ctx.maxHoldingSeconds) return null;
    return {
      ruleId: this.id,
      action: { kind: "EXIT_ALL", urgency: "NORMAL" },
      detail: `Haltedauer ${Math.round(ctx.market.holdingSeconds / 60)} min erreicht`,
    };
  },
};

/**
 * Reihenfolge ist Rangfolge: Risiko-Stops zuerst, dann Momentum, dann Zeit.
 * Der erste Sofortausstieg gewinnt.
 */
export const ALL_EXIT_RULES: readonly ExitRule[] = [
  EXECUTION_FAILURE,
  LIQUIDITY_COLLAPSE,
  DEV_SOLD,
  SECURITY_DOWNGRADE,
  SMART_MONEY_EXIT,
  MOMENTUM_COLLAPSE,
  SELL_PRESSURE,
  STRONG_RUNNER,
  MAX_HOLDING_TIME,
];

export const EXIT_RULE_IDS = ALL_EXIT_RULES.map((r) => r.id);
