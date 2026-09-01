import type { Clock, OpportunityState, SourceType } from "@sae/core";

import {
  revalidate,
  type FieldChange,
  type MarketSnapshot,
  type RevalidationLimits,
} from "./revalidation";

/**
 * INVEST NOW — die Pruefkette hinter dem Klick.
 *
 * Der Nutzer hat vor Minuten eine Mail bekommen. Was darin stand, gilt jetzt
 * moeglicherweise nicht mehr. Deshalb wird der gesamte Zustand NEU erhoben und
 * gegen den Alert gestellt — und der Alert-Preis wird **niemals** als Einstieg
 * verwendet.
 *
 * Die Reihenfolge der Pruefungen ist Absicht: zuerst das, was ohne Marktdaten
 * entscheidbar ist (abgelaufen, schon beantwortet), dann das, was Daten
 * braucht. So nennt eine Blockade den eigentlichen Grund und nicht den
 * Folgefehler — „abgelaufen" ist eine bessere Auskunft als „keine Daten", wenn
 * beides zutrifft.
 *
 * Diese Funktion ist rein: kein Datenbankzugriff, kein Netz, keine Uhr ausser
 * der injizierten. Sie entscheidet nur. Das Laden und Schreiben gehoert in die
 * Route, damit beides einzeln pruefbar bleibt.
 */

export type ConfirmationBlock =
  /** Einmal-Token unbekannt, verbraucht oder abgelaufen. */
  | "TOKEN_INVALID"
  | "OPPORTUNITY_NOT_FOUND"
  /** Der Bestaetigungsweg gilt nur fuer den Manual-Strom. */
  | "WRONG_STREAM"
  /** Schon beantwortet — bestaetigt, abgelehnt, abgelaufen oder zurueckgezogen. */
  | "ALREADY_RESOLVED"
  | "EXPIRED"
  /** Keine erreichbare Quelle. Ohne aktuelle Daten wird nicht bestaetigt. */
  | "NO_LIVE_DATA"
  | "PRICE_DRIFT"
  | "LIQUIDITY_DROPPED"
  | "SECURITY_WORSE"
  | "SCORE_DROPPED"
  | "EV_NOT_POSITIVE"
  | "PORTFOLIO_RISK"
  /** Live-Handel ist in dieser Phase vollstaendig abgeschaltet. */
  | "LIVE_TRADING_DISABLED";

export type ConfirmationDecision =
  | {
      readonly kind: "CONFIRM";
      readonly revalidationId: string;
      readonly validUntil: Date;
      readonly changes: readonly FieldChange[];
      /** In dieser Phase immer PAPER. */
      readonly executes: "PAPER";
    }
  | {
      readonly kind: "BLOCK";
      readonly reason: ConfirmationBlock;
      readonly detail: string;
      readonly changes: readonly FieldChange[];
    };

export interface PortfolioRisk {
  /** Offene Positionen im Manual-Strom. */
  readonly openPositions: number;
  readonly maxOpenPositions: number;
}

export interface ConfirmationInput {
  readonly tokenValid: boolean;
  readonly opportunity: {
    readonly id: string;
    readonly stream: string;
    readonly state: OpportunityState;
    readonly respondBy: Date | null;
    readonly sourceType: SourceType;
  } | null;
  /** Zustand zum Zeitpunkt des Alerts, aus dem Feature-Snapshot. */
  readonly atAlert: MarketSnapshot;
  /** Frisch erhoben. `null`, wenn keine Quelle geantwortet hat. */
  readonly now: MarketSnapshot | null;
  readonly noLiveDataReason: string;
  /** Erwartungswert aus den aktuellen Daten. `null` = nicht berechenbar. */
  readonly expectedValue: number | null;
  readonly portfolio: PortfolioRisk;
  readonly liveTradingRequested: boolean;
  readonly clock: Clock;
  readonly limits?: RevalidationLimits;
  readonly newRevalidationId: () => string;
}

/** Zustaende, aus denen eine Bestaetigung noch moeglich ist. */
const OPEN_STATES: ReadonlySet<OpportunityState> = new Set<OpportunityState>(["OFFERED", "SEEN"]);

const block = (
  reason: ConfirmationBlock,
  detail: string,
  changes: readonly FieldChange[] = [],
): ConfirmationDecision => ({ kind: "BLOCK", reason, detail, changes });

export function evaluateConfirmation(input: ConfirmationInput): ConfirmationDecision {
  // Live bleibt in dieser Phase vollstaendig aus. Die Pruefung steht ganz vorn:
  // wer Live anfordert, bekommt kein Paper als Trostpreis, sondern eine klare
  // Absage.
  if (input.liveTradingRequested) {
    return block(
      "LIVE_TRADING_DISABLED",
      "Live-Handel ist abgeschaltet. Dieser Weg loest ausschliesslich Paper Trading aus.",
    );
  }

  if (!input.tokenValid) {
    return block("TOKEN_INVALID", "Der Link ist ungueltig, verbraucht oder abgelaufen.");
  }

  const opportunity = input.opportunity;
  if (opportunity === null) {
    return block("OPPORTUNITY_NOT_FOUND", "Zu diesem Link gibt es keine Gelegenheit.");
  }
  if (opportunity.stream !== "MANUAL_PAPER") {
    return block(
      "WRONG_STREAM",
      `Der Bestaetigungsweg gilt nur fuer den Manual-Strom, nicht fuer ${opportunity.stream}.`,
    );
  }
  if (!OPEN_STATES.has(opportunity.state)) {
    return block(
      "ALREADY_RESOLVED",
      `Diese Gelegenheit steht bereits auf ${opportunity.state}.`,
    );
  }

  // Ablauf vor Marktdaten: eine abgelaufene Gelegenheit ist abgelaufen, auch
  // wenn zufaellig gerade Daten da waeren.
  const now = input.clock.now();
  if (opportunity.respondBy !== null && now.getTime() > opportunity.respondBy.getTime()) {
    return block(
      "EXPIRED",
      `Das Antwortfenster endete am ${opportunity.respondBy.toISOString()}.`,
    );
  }

  if (input.now === null) {
    // I: Ein Datenausfall darf niemals ein gueltiges Handelssignal erzeugen.
    // Der Alert-Preis als Ersatz waere genau der Fehler, den diese Pruefung
    // verhindern soll.
    return block("NO_LIVE_DATA", input.noLiveDataReason);
  }

  const result = revalidate({
    atAlert: input.atAlert,
    now: input.now,
    intentCreatedAt: input.atAlert.at,
    clock: input.clock,
    newRevalidationId: input.newRevalidationId,
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });

  if (!result.ok) {
    // Die Revalidierung nennt mehrere Gruende; fuer die Anzeige gewinnt der
    // schwerwiegendste. Sicherheit vor Liquiditaet vor Preis vor Score.
    const blocking = result.changes.filter((c) => c.blocking).map((c) => c.field);
    const reason: ConfirmationBlock = blocking.includes("Risiko")
      ? "SECURITY_WORSE"
      : blocking.includes("Liquiditaet")
        ? "LIQUIDITY_DROPPED"
        : blocking.includes("Preis")
          ? "PRICE_DRIFT"
          : blocking.includes("Score")
            ? "SCORE_DROPPED"
            : "EXPIRED";
    return block(reason, result.message, result.changes);
  }

  // Erwartungswert auf den NEUEN Daten. `null` blockiert ebenfalls: nicht
  // berechenbar ist nicht dasselbe wie unauffaellig.
  if (input.expectedValue === null) {
    return block(
      "EV_NOT_POSITIVE",
      "Der Erwartungswert ist mit den aktuellen Daten nicht berechenbar.",
      result.changes,
    );
  }
  if (input.expectedValue <= 0) {
    return block(
      "EV_NOT_POSITIVE",
      `Der Erwartungswert liegt bei ${(input.expectedValue * 100).toFixed(1)} % und traegt keinen Einstieg.`,
      result.changes,
    );
  }

  if (input.portfolio.openPositions >= input.portfolio.maxOpenPositions) {
    return block(
      "PORTFOLIO_RISK",
      `Bereits ${String(input.portfolio.openPositions)} von ${String(input.portfolio.maxOpenPositions)} Positionen offen.`,
      result.changes,
    );
  }

  return {
    kind: "CONFIRM",
    revalidationId: result.revalidationId,
    validUntil: result.validUntil,
    changes: result.changes,
    executes: "PAPER",
  };
}
