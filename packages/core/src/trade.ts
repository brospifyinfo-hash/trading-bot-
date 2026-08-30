import type {
  ExecutionId,
  IntentId,
  Mint,
  PositionId,
  StrategyVersionId,
  TokenId,
  TxSignature,
  WalletAddress,
} from "./ids";
import type { Bps, Lamports, Money } from "./money";
import type { TradeState } from "./trade-state-machine";

/** Paper und Live laufen durch dieselbe Logik; nur der Executor unterscheidet sich. */
export type TradeMode = "paper" | "live";
export type TradeOrigin = "auto" | "manual";
export type Side = "buy" | "sell";

export interface TradeIntent {
  readonly intentId: IntentId;
  readonly tokenId: TokenId;
  readonly mint: Mint;
  readonly mode: TradeMode;
  readonly origin: TradeOrigin;
  readonly side: Side;
  readonly state: TradeState;
  /** Verhindert, dass derselbe Auftrag zweimal ausgefuehrt wird. */
  readonly idempotencyKey: string;
  readonly plannedNotional: Money;
  readonly maxSlippageBps: Bps;
  readonly strategyVersionId: StrategyVersionId;
  readonly createdAt: Date;
  /** Nach Ablauf wird der Intent verworfen statt ausgefuehrt. */
  readonly expiresAt: Date;
}

export interface Quote {
  readonly inputMint: Mint;
  readonly outputMint: Mint;
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  /** Garantierte Mindestmenge nach Slippage-Toleranz. Pflicht — nie 0. */
  readonly minOutAmount: bigint;
  readonly priceImpactBps: Bps;
  readonly routeLabel: string;
  readonly quotedAt: Date;
}

export interface ExecutionCostBreakdown {
  readonly networkFee: Lamports;
  readonly priorityFee: Lamports;
  readonly tip: Lamports;
  readonly dexFee: Money;
  readonly priceImpact: Money;
  readonly latencyDrift: Money;
  readonly total: Money;
}

export interface ExecutionAttempt {
  readonly executionId: ExecutionId;
  readonly intentId: IntentId;
  readonly quote: Quote;
  readonly costs: ExecutionCostBreakdown;
  readonly signature: TxSignature | null;
  readonly state: TradeState;
  readonly submittedAt: Date | null;
  readonly confirmedAt: Date | null;
  readonly error: string | null;
}

export interface TakeProfitLevel {
  readonly index: number;
  /** Auslösung bei diesem Gewinn in Basispunkten (z. B. 2500 bp = +25 %). */
  readonly triggerGainBps: Bps;
  /** Anteil der Ursprungsposition, der verkauft wird. */
  readonly sellPortionBps: Bps;
  readonly hitAt: Date | null;
}

export interface Position {
  readonly positionId: PositionId;
  readonly tokenId: TokenId;
  readonly mint: Mint;
  readonly mode: TradeMode;
  readonly origin: TradeOrigin;
  readonly wallet: WalletAddress | null;
  readonly state: TradeState;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  /** Gewichteter Einstand in kleinster Token-Einheit. */
  readonly entryAmountRaw: bigint;
  readonly remainingAmountRaw: bigint;
  readonly entryNotional: Money;
  readonly realizedPnl: Money;
  readonly costsPaid: Money;
  readonly takeProfits: readonly TakeProfitLevel[];
  readonly stopLossBps: Bps;
  readonly trailingStopBps: Bps | null;
  readonly strategyVersionId: StrategyVersionId;
}

export type PositionEventKind =
  | "OPENED"
  | "TP_HIT"
  | "PARTIAL_SOLD"
  | "TRAILING_ARMED"
  | "TRAILING_UPDATED"
  | "STOP_LOSS_HIT"
  | "RISK_STOP_TRIGGERED"
  | "EMERGENCY_EXIT"
  | "CLOSED"
  | "RECONCILED";

/** Append-only. Der Zustand einer Position ergibt sich aus ihrer Ereigniskette. */
export interface PositionEvent {
  readonly positionId: PositionId;
  readonly kind: PositionEventKind;
  readonly at: Date;
  readonly detail: Readonly<Record<string, unknown>>;
}
