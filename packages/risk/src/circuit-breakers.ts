import type { Clock } from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import { dailyLossPct, type PortfolioState } from "./portfolio";

/**
 * Circuit Breaker.
 *
 * Zwei Regeln, die sie von gewoehnlichen Feature-Flags unterscheiden:
 *
 * 1. Der Zustand gehoert in die Datenbank, nicht in den Prozessspeicher. Sonst
 *    genuegt ein Absturz, um einen ausgeloesten Tagesverlust-Lockout aufzuheben —
 *    also genau in dem Moment, in dem der Schutz am noetigsten ist.
 *
 * 2. Sie blockieren EINSTIEGE haerter als AUSSTIEGE. Ein System, das wegen eines
 *    Provider-Ausfalls eine laufende Position nicht mehr schliessen kann, hat das
 *    Risiko vergroessert statt verkleinert. Deshalb traegt jeder Breaker, was er
 *    tatsaechlich verbietet.
 */

export type BreakerName =
  | "DAILY_LOSS"
  | "CONSECUTIVE_LOSSES"
  | "PORTFOLIO_EXPOSURE"
  | "PROVIDER_HEALTH"
  | "DATA_STALENESS"
  | "RECONCILIATION_DRIFT"
  | "EMERGENCY_STOP";

/** Was ein ausgeloester Breaker verbietet. */
export type BreakerScope =
  /** Nur neue Einstiege. Positionsverwaltung und Ausstiege laufen weiter. */
  | "ENTRIES_ONLY"
  /** Alles — auch automatische Ausstiege. Nur fuer Faelle, in denen weiteres
   *  Handeln nachweislich schlimmer ist als Stillstand. */
  | "ALL_TRADING";

export interface BreakerDefinition {
  readonly name: BreakerName;
  readonly scope: BreakerScope;
  readonly description: string;
}

export const BREAKERS: Readonly<Record<BreakerName, BreakerDefinition>> = {
  DAILY_LOSS: {
    name: "DAILY_LOSS",
    scope: "ENTRIES_ONLY",
    description: "Tagesverlustgrenze erreicht",
  },
  CONSECUTIVE_LOSSES: {
    name: "CONSECUTIVE_LOSSES",
    scope: "ENTRIES_ONLY",
    description: "Zu viele Verluste in Folge",
  },
  PORTFOLIO_EXPOSURE: {
    name: "PORTFOLIO_EXPOSURE",
    scope: "ENTRIES_ONLY",
    description: "Portfolio-Exposure am Limit",
  },
  PROVIDER_HEALTH: {
    name: "PROVIDER_HEALTH",
    scope: "ENTRIES_ONLY",
    description: "Kritische Datenquelle nicht verfuegbar",
  },
  DATA_STALENESS: {
    name: "DATA_STALENESS",
    scope: "ENTRIES_ONLY",
    description: "Daten zu alt fuer eine Einstiegsentscheidung",
  },
  RECONCILIATION_DRIFT: {
    // Der einzige automatische Breaker, der alles anhaelt: wenn interner und
    // tatsaechlicher Bestand auseinanderlaufen, ist jede weitere Order ein Schuss
    // ins Dunkle — auch ein Verkauf.
    name: "RECONCILIATION_DRIFT",
    scope: "ALL_TRADING",
    description: "Interner Bestand weicht von der Chain ab",
  },
  EMERGENCY_STOP: {
    name: "EMERGENCY_STOP",
    scope: "ALL_TRADING",
    description: "Manuell ausgeloester Notstopp",
  },
};

export interface BreakerState {
  readonly name: BreakerName;
  readonly state: "CLOSED" | "OPEN";
  readonly openedAt: Date | null;
  readonly cooldownUntil: Date | null;
  readonly reason: string | null;
}

export interface BreakerAssessment {
  readonly open: readonly BreakerState[];
  readonly entriesBlocked: boolean;
  readonly allTradingBlocked: boolean;
  readonly reasons: readonly string[];
}

/**
 * Wertet den gespeicherten Zustand plus die aktuell berechenbaren Bedingungen aus.
 *
 * Die gespeicherten Breaker gewinnen: ein ausgeloester Lockout bleibt bestehen,
 * bis seine Abkuehlzeit abgelaufen ist — auch wenn die ausloesende Bedingung
 * gerade nicht mehr zutrifft. Sonst waere ein kurz erholtes Portfolio genug, um
 * sofort weiterzuhandeln.
 */
export function assessBreakers(input: {
  readonly persisted: readonly BreakerState[];
  readonly portfolio: PortfolioState;
  readonly parameters: StrategyParameters;
  readonly criticalProvidersUnavailable: readonly string[];
  readonly dataStale: boolean;
  readonly clock: Clock;
}): BreakerAssessment {
  const now = input.clock.now();
  const open: BreakerState[] = [];
  const reasons: string[] = [];

  for (const persisted of input.persisted) {
    if (persisted.state !== "OPEN") continue;
    if (persisted.cooldownUntil !== null && persisted.cooldownUntil <= now) continue;
    open.push(persisted);
    reasons.push(persisted.reason ?? BREAKERS[persisted.name].description);
  }

  const already = new Set(open.map((b) => b.name));
  const raise = (name: BreakerName, reason: string): void => {
    if (already.has(name)) return;
    open.push({ name, state: "OPEN", openedAt: now, cooldownUntil: null, reason });
    reasons.push(reason);
    already.add(name);
  };

  const loss = dailyLossPct(input.portfolio);
  if (loss >= input.parameters.risk.maxDailyLossPct) {
    raise("DAILY_LOSS", `Tagesverlust ${loss.toFixed(2)} % erreicht die Grenze`);
  }

  if (input.portfolio.consecutiveLosses >= input.parameters.risk.maxConsecutiveLosses) {
    raise(
      "CONSECUTIVE_LOSSES",
      `${input.portfolio.consecutiveLosses} Verluste in Folge`,
    );
  }

  if (input.criticalProvidersUnavailable.length > 0) {
    raise(
      "PROVIDER_HEALTH",
      `Kritische Quellen nicht verfuegbar: ${input.criticalProvidersUnavailable.join(", ")}`,
    );
  }

  if (input.dataStale) {
    raise("DATA_STALENESS", "Daten zu alt fuer eine Einstiegsentscheidung");
  }

  const allTradingBlocked = open.some((b) => BREAKERS[b.name].scope === "ALL_TRADING");
  return {
    open,
    entriesBlocked: open.length > 0,
    allTradingBlocked,
    reasons,
  };
}
