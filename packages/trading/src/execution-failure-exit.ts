import type { ExitRule, ExitSignal } from "./exit-rules";

/**
 * Die neunte Verlustregel: Ausstieg, wenn die AUSFUEHRUNG scheitert.
 *
 * §26 fuehrt sie unter den Verlustregeln und nicht in der Fehlerbehandlung —
 * zu Recht. Eine Position, aus der man nicht herauskommt, ist ein
 * Risikoereignis, kein technischer Vorfall. Der Verlust waechst weiter,
 * waehrend die Wiederholungslogik zaehlt.
 *
 * Der Kern der Regel ist eine Unterscheidung, deren Fehlen teuer wird:
 *
 * **Ein Infrastrukturausfall ist kein Beleg dafuer, dass ein Token illiquide
 * ist.** Zaehlt man einen RPC-Ausfall wie ueberschrittene Slippage, dann loest
 * ein einziger Providerausfall gestueckelte Notausstiege ueber das gesamte
 * Portfolio aus — gleichzeitig, und ausgerechnet in dem Moment, in dem
 * niemand zuverlaessig handeln kann. Aus einem Betriebsproblem wird so ein
 * realisierter Verlust.
 *
 * Deshalb zwei Klassen:
 *
 *   MARKTSEITIG   Slippage ueberschritten, keine Route, Blockhash abgelaufen.
 *                 Der Markt gibt die Order nicht her → eskalieren, notfalls
 *                 gestueckelt aussteigen.
 *   BETRIEBLICH   RPC weg, kein SOL fuer Gebuehren, Signer lehnt ab.
 *                 Wiederholen bringt nichts → Alarm, Handel anhalten. Und
 *                 ausdruecklich NICHT: die Policy lockern, um herauszukommen.
 */

export type ExitFailureKind =
  /** Der Kurs lief zwischen Quote und Fill aus der Toleranz. */
  | "SLIPPAGE_EXCEEDED"
  /** Kein Router konnte den Verkauf abbilden. */
  | "NO_ROUTE"
  /** Transaktion wurde nicht rechtzeitig eingebracht. */
  | "BLOCKHASH_EXPIRED"
  /** Knoten nicht erreichbar. */
  | "RPC_UNAVAILABLE"
  /** Kein SOL fuer Gebuehren. Betrifft ALLE Positionen gleichzeitig. */
  | "INSUFFICIENT_FEE_BALANCE"
  /** Der Signer hat die Transaktion nach Policy abgelehnt. */
  | "POLICY_REJECTED";

const MARKET_SIDE: ReadonlySet<ExitFailureKind> = new Set<ExitFailureKind>([
  "SLIPPAGE_EXCEEDED",
  "NO_ROUTE",
  "BLOCKHASH_EXPIRED",
]);

export function isMarketSideFailure(kind: ExitFailureKind): boolean {
  return MARKET_SIDE.has(kind);
}

export interface ExitExecutionState {
  /** Gescheiterte Ausstiegsversuche in Folge, unabhaengig von der Ursache. */
  readonly consecutiveFailures: number;
  /** Davon marktseitige. Nur diese belegen, dass der Markt die Order nicht hergibt. */
  readonly consecutiveMarketSideFailures: number;
  readonly lastFailureKind: ExitFailureKind | null;
  /** Zeit seit dem ersten Fehlschlag dieser Serie. */
  readonly secondsSinceFirstFailure: number | null;
}

export const NO_EXECUTION_FAILURES: ExitExecutionState = {
  consecutiveFailures: 0,
  consecutiveMarketSideFailures: 0,
  lastFailureKind: null,
  secondsSinceFirstFailure: null,
};

export interface ExecutionFailureThresholds {
  /** Ab so vielen marktseitigen Fehlschlaegen wird gestueckelt ausgestiegen. */
  readonly marketFailuresBeforeTranching: number;
  /** Ab so lange andauernder Serie ebenfalls, unabhaengig von der Zahl. */
  readonly secondsBeforeTranching: number;
  /** Ab so vielen betrieblichen Fehlschlaegen wird Alarm ausgeloest. */
  readonly operationalFailuresBeforeAlarm: number;
}

export const DEFAULT_EXECUTION_FAILURE_THRESHOLDS: ExecutionFailureThresholds = {
  marketFailuresBeforeTranching: 3,
  secondsBeforeTranching: 120,
  operationalFailuresBeforeAlarm: 2,
};

export type ExecutionFailureAssessment =
  | { readonly kind: "NO_ACTION" }
  | {
      /** Der Markt gibt die Order nicht her — gestueckelt aussteigen. */
      readonly kind: "ESCALATE_TO_TRANCHED_EXIT";
      readonly detail: string;
    }
  | {
      /**
       * Betriebsproblem. Wiederholen bringt nichts, und der Markt ist nicht
       * die Ursache — es wird also auch nicht verkauft.
       */
      readonly kind: "OPERATIONAL_ALARM";
      readonly failureKind: ExitFailureKind;
      readonly haltNewEntries: boolean;
      readonly detail: string;
    };

export function assessExecutionFailure(
  state: ExitExecutionState,
  thresholds: ExecutionFailureThresholds = DEFAULT_EXECUTION_FAILURE_THRESHOLDS,
): ExecutionFailureAssessment {
  if (state.consecutiveFailures === 0 || state.lastFailureKind === null) {
    return { kind: "NO_ACTION" };
  }

  const operationalFailures = state.consecutiveFailures - state.consecutiveMarketSideFailures;

  // Betriebliches zuerst: kein SOL fuer Gebuehren betrifft jede Position, und
  // ein gestueckelter Ausstieg scheitert daran genauso wie ein ganzer.
  if (
    !isMarketSideFailure(state.lastFailureKind) &&
    operationalFailures >= thresholds.operationalFailuresBeforeAlarm
  ) {
    const blocksEverything =
      state.lastFailureKind === "INSUFFICIENT_FEE_BALANCE" ||
      state.lastFailureKind === "POLICY_REJECTED";
    return {
      kind: "OPERATIONAL_ALARM",
      failureKind: state.lastFailureKind,
      // Neue Einstiege anhalten: wer nicht aussteigen kann, darf nicht
      // einsteigen. Bestehende Positionen werden deshalb NICHT verkauft — der
      // Markt ist nicht die Ursache, und ein Verkauf unter Zwang ist teuer.
      haltNewEntries: blocksEverything,
      detail: `${operationalFailures} betriebliche Fehlschlaege (${state.lastFailureKind})`,
    };
  }

  const longEnough =
    state.secondsSinceFirstFailure !== null &&
    state.secondsSinceFirstFailure >= thresholds.secondsBeforeTranching;
  const oftenEnough =
    state.consecutiveMarketSideFailures >= thresholds.marketFailuresBeforeTranching;

  if (state.consecutiveMarketSideFailures > 0 && (longEnough || oftenEnough)) {
    return {
      kind: "ESCALATE_TO_TRANCHED_EXIT",
      detail:
        `${state.consecutiveMarketSideFailures} marktseitige Fehlschlaege` +
        (state.secondsSinceFirstFailure !== null
          ? `, seit ${Math.round(state.secondsSinceFirstFailure)} s`
          : ""),
    };
  }

  return { kind: "NO_ACTION" };
}

/**
 * Als Regel im Regelsatz.
 *
 * Sie liefert nur bei marktseitiger Eskalation ein Signal. Ein Betriebsalarm
 * ist bewusst KEIN Ausstiegssignal: verkauft wird, weil der Markt sich gedreht
 * hat, nicht weil ein Knoten nicht antwortet.
 */
export const EXECUTION_FAILURE: ExitRule = {
  id: "DYN_EXECUTION_FAILURE",
  description: "Ausstieg scheitert wiederholt am Markt — gestueckelt aussteigen",
  evaluate(ctx): ExitSignal | null {
    const state = ctx.execution;
    if (state === null || state === undefined) return null;
    const assessment = assessExecutionFailure(state);
    if (assessment.kind !== "ESCALATE_TO_TRANCHED_EXIT") return null;
    return {
      ruleId: this.id,
      action: { kind: "EXIT_ALL", urgency: "IMMEDIATE" },
      detail: assessment.detail,
    };
  },
};
