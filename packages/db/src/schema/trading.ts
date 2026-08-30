import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { strategyVersions } from "./strategy";
import { wallets } from "./identity";

export const TRADE_STATES = [
  "INTENT_CREATED",
  "PRE_TRADE_VALIDATION",
  "QUOTED",
  "SIGNING",
  "SUBMITTED",
  "CONFIRMED",
  "OPEN",
  "PARTIALLY_CLOSED",
  "CLOSING",
  "CLOSED",
  "UNKNOWN",
  "RECONCILING",
  "FAILED",
  "ABORTED_STALE",
  "ABORTED_POLICY",
  "ABORTED_EXPIRED",
  "SIGN_REJECTED",
] as const;

export const tradeIntents = pgTable(
  "trade_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    mint: text("mint").notNull(),
    mode: text("mode", { enum: ["paper", "live"] }).notNull(),
    origin: text("origin", { enum: ["auto", "manual"] }).notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    state: text("state", { enum: TRADE_STATES }).notNull().default("INTENT_CREATED"),
    /** Zweite Verteidigungslinie gegen Doppelausfuehrung. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    plannedNotionalMinor: bigint("planned_notional_minor", { mode: "bigint" }).notNull(),
    currency: text("currency", { enum: ["EUR", "USD"] }).notNull(),
    maxSlippageBps: integer("max_slippage_bps").notNull(),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Nach Ablauf wird der Intent verworfen statt ausgefuehrt. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    /**
     * Erste Verteidigungslinie: pro Mint und Modus darf hoechstens ein Intent
     * gleichzeitig in Bearbeitung sein. Der partielle Index laesst beliebig viele
     * abgeschlossene Intents zu und blockiert nur die aktiven.
     */
    uniqueIndex("trade_intents_one_active_per_mint")
      .on(t.tokenId, t.mode)
      .where(
        sql`state in ('INTENT_CREATED','PRE_TRADE_VALIDATION','QUOTED','SIGNING','SUBMITTED','UNKNOWN','RECONCILING')`,
      ),
    index("trade_intents_state_idx").on(t.state),
  ],
);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  intentId: uuid("intent_id")
    .notNull()
    .references(() => tradeIntents.id, { onDelete: "cascade" }),
  kind: text("kind", {
    enum: ["ENTRY", "TAKE_PROFIT", "STOP_LOSS", "TRAILING_STOP", "EMERGENCY_EXIT", "MANUAL_EXIT"],
  }).notNull(),
  targetAmountRaw: bigint("target_amount_raw", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => tradeIntents.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id),
    state: text("state", { enum: TRADE_STATES }).notNull(),

    quoteInAmount: bigint("quote_in_amount", { mode: "bigint" }),
    quoteOutAmount: bigint("quote_out_amount", { mode: "bigint" }),
    /** Garantierte Mindestmenge. Pflichtfeld im Signer-Policy-Check. */
    minOutAmount: bigint("min_out_amount", { mode: "bigint" }),
    priceImpactBps: integer("price_impact_bps"),
    routeLabel: text("route_label"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),

    networkFeeLamports: bigint("network_fee_lamports", { mode: "bigint" }),
    priorityFeeLamports: bigint("priority_fee_lamports", { mode: "bigint" }),
    tipLamports: bigint("tip_lamports", { mode: "bigint" }),
    estimatedCostMinor: bigint("estimated_cost_minor", { mode: "bigint" }),
    actualCostMinor: bigint("actual_cost_minor", { mode: "bigint" }),
    /** Differenz erwartet/real — Grundlage der Kostenmodell-Kalibrierung. */
    realizedSlippageBps: integer("realized_slippage_bps"),
    executionDelayMs: integer("execution_delay_ms"),

    signature: text("signature"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [index("executions_intent_idx").on(t.intentId), index("executions_sig_idx").on(t.signature)],
);

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "restrict" }),
    mint: text("mint").notNull(),
    mode: text("mode", { enum: ["paper", "live"] }).notNull(),
    origin: text("origin", { enum: ["auto", "manual"] }).notNull(),
    walletId: uuid("wallet_id").references(() => wallets.id),
    state: text("state", { enum: TRADE_STATES }).notNull(),

    entryAmountRaw: bigint("entry_amount_raw", { mode: "bigint" }).notNull(),
    remainingAmountRaw: bigint("remaining_amount_raw", { mode: "bigint" }).notNull(),
    entryNotionalMinor: bigint("entry_notional_minor", { mode: "bigint" }).notNull(),
    realizedPnlMinor: bigint("realized_pnl_minor", { mode: "bigint" }).notNull().default(sql`0`),
    costsPaidMinor: bigint("costs_paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    currency: text("currency", { enum: ["EUR", "USD"] }).notNull(),

    stopLossBps: integer("stop_loss_bps").notNull(),
    trailingStopBps: integer("trailing_stop_bps"),
    highWaterMarkPrice: doublePrecision("high_water_mark_price"),

    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    scoreEngineVersion: text("score_engine_version"),
    entryFinalScore: smallint("entry_final_score"),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("positions_state_idx").on(t.state),
    index("positions_mode_idx").on(t.mode, t.openedAt),
    index("positions_token_idx").on(t.tokenId),
  ],
);

/** Append-only. Der Zustand einer Position ergibt sich aus ihrer Ereigniskette. */
export const positionEvents = pgTable(
  "position_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "OPENED",
        "TP_HIT",
        "PARTIAL_SOLD",
        "TRAILING_ARMED",
        "TRAILING_UPDATED",
        "STOP_LOSS_HIT",
        "RISK_STOP_TRIGGERED",
        "EMERGENCY_EXIT",
        "CLOSED",
        "RECONCILED",
      ],
    }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("position_events_pos_idx").on(t.positionId, t.at)],
);

export const takeProfits = pgTable("take_profits", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id")
    .notNull()
    .references(() => positions.id, { onDelete: "cascade" }),
  levelIndex: integer("level_index").notNull(),
  triggerGainBps: integer("trigger_gain_bps").notNull(),
  sellPortionBps: integer("sell_portion_bps").notNull(),
  hitAt: timestamp("hit_at", { withTimezone: true }),
  soldAmountRaw: bigint("sold_amount_raw", { mode: "bigint" }),
});

/** Paper-spezifische Zusatzdaten: die vollstaendige simulierte Kostenaufschluesselung. */
export const paperTrades = pgTable("paper_trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  positionId: uuid("position_id")
    .notNull()
    .references(() => positions.id, { onDelete: "cascade" }),
  virtualCapitalMinor: bigint("virtual_capital_minor", { mode: "bigint" }).notNull(),
  costBreakdown: jsonb("cost_breakdown").notNull(),
  /** Modellannahmen dieses Laufs — ohne sie ist die Zahl nicht reproduzierbar. */
  costModelVersion: text("cost_model_version").notNull(),
  assumedLatencyMs: integer("assumed_latency_ms").notNull(),
  assumedFailureRate: doublePrecision("assumed_failure_rate").notNull(),
});
