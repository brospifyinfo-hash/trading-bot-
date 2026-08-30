import { StateMachine, type TransitionTable } from "./state-machine";

/**
 * Lebenszyklus eines Trades — von der Absicht bis zur geschlossenen Position.
 *
 * Zum Zustand UNKNOWN: er entsteht, wenn eine Transaktion gesendet wurde, wir ihre
 * Bestaetigung aber nicht beobachten konnten (RPC-Timeout, Neustart, Netzwerkfehler).
 * Er darf NIEMALS wie FAILED behandelt werden. Waere er das, wuerde das System nach
 * einem Timeout erneut kaufen und am Ende die doppelte Position halten, ohne es zu
 * wissen. UNKNOWN fuehrt ausschliesslich nach RECONCILING; erst der Abgleich mit der
 * Chain entscheidet, ob daraus CONFIRMED oder FAILED wird.
 */
export type TradeState =
  | "INTENT_CREATED"
  | "PRE_TRADE_VALIDATION"
  | "QUOTED"
  | "SIGNING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "OPEN"
  | "PARTIALLY_CLOSED"
  | "CLOSING"
  | "CLOSED"
  | "UNKNOWN"
  | "RECONCILING"
  | "FAILED"
  | "ABORTED_STALE"
  | "ABORTED_POLICY"
  | "ABORTED_EXPIRED"
  | "SIGN_REJECTED";

const TABLE: TransitionTable<TradeState> = {
  INTENT_CREATED: ["PRE_TRADE_VALIDATION", "ABORTED_EXPIRED"],
  PRE_TRADE_VALIDATION: ["QUOTED", "ABORTED_STALE", "ABORTED_POLICY", "ABORTED_EXPIRED"],
  QUOTED: ["SIGNING", "ABORTED_STALE", "ABORTED_POLICY"],
  SIGNING: ["SUBMITTED", "SIGN_REJECTED"],
  SUBMITTED: ["CONFIRMED", "FAILED", "UNKNOWN"],
  CONFIRMED: ["OPEN"],
  OPEN: ["PARTIALLY_CLOSED", "CLOSING"],
  PARTIALLY_CLOSED: ["PARTIALLY_CLOSED", "OPEN", "CLOSING"],
  CLOSING: ["CLOSED", "UNKNOWN"],
  CLOSED: [],
  UNKNOWN: ["RECONCILING"],
  RECONCILING: ["CONFIRMED", "FAILED", "OPEN", "CLOSED"],
  FAILED: [],
  ABORTED_STALE: [],
  ABORTED_POLICY: [],
  ABORTED_EXPIRED: [],
  SIGN_REJECTED: [],
};

export const tradeStateMachine = new StateMachine<TradeState>("TradeLifecycle", TABLE);

/** Zustaende, in denen echtes Kapital in diesem Token gebunden ist. */
const CAPITAL_AT_RISK: ReadonlySet<TradeState> = new Set<TradeState>([
  "OPEN",
  "PARTIALLY_CLOSED",
  "CLOSING",
]);

/**
 * Zustaende, die weitere Aktionen auf demselben Mint blockieren muessen.
 *
 * UNKNOWN und RECONCILING gehoeren bewusst dazu: solange unklar ist, ob wir die
 * Position halten, darf kein zweiter Einstieg erfolgen.
 */
const BLOCKS_MINT: ReadonlySet<TradeState> = new Set<TradeState>([
  "INTENT_CREATED",
  "PRE_TRADE_VALIDATION",
  "QUOTED",
  "SIGNING",
  "SUBMITTED",
  "CONFIRMED",
  "OPEN",
  "PARTIALLY_CLOSED",
  "CLOSING",
  "UNKNOWN",
  "RECONCILING",
]);

export const hasCapitalAtRisk = (s: TradeState): boolean => CAPITAL_AT_RISK.has(s);
export const blocksNewEntryOnMint = (s: TradeState): boolean => BLOCKS_MINT.has(s);
export const needsReconciliation = (s: TradeState): boolean =>
  s === "UNKNOWN" || s === "RECONCILING";
