import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { positions, tradeIntents } from "./trading";
import { strategyVersions } from "./strategy";
import { users } from "./identity";

export const riskEvents = pgTable(
  "risk_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
    detail: jsonb("detail").notNull().default({}),
    positionId: uuid("position_id").references(() => positions.id),
    tokenId: uuid("token_id").references(() => tokens.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("risk_events_time_idx").on(t.at)],
);

/**
 * Persistenter Zustand der Circuit Breaker.
 *
 * Bewusst in der Datenbank und nicht im Prozessspeicher: ein Neustart darf einen
 * ausgeloesten Tagesverlust-Lockout nicht aufheben. Sonst genuegt ein Absturz,
 * um die wichtigste Schutzschaltung des Systems zu umgehen.
 */
export const circuitBreakerState = pgTable("circuit_breaker_state", {
  name: text("name").primaryKey(),
  state: text("state", { enum: ["CLOSED", "OPEN", "HALF_OPEN"] }).notNull().default("CLOSED"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  /** Vor diesem Zeitpunkt wird nicht zurueckgeschaltet. */
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  reason: text("reason"),
  detail: jsonb("detail").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerHealth = pgTable(
  "provider_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    status: text("status", { enum: ["HEALTHY", "DEGRADED", "DOWN"] }).notNull(),
    latencyMs: integer("latency_ms"),
    errorRate: doublePrecision("error_rate"),
    /** Verbrauchtes Monatsbudget in Prozent — schuetzt vor Ueberraschungsrechnungen. */
    budgetUsedPct: doublePrecision("budget_used_pct"),
    detail: jsonb("detail").notNull().default({}),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("provider_health_idx").on(t.provider, t.observedAt)],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    tokenId: uuid("token_id").references(() => tokens.id),
    /** Grundlage der Deduplizierung: gleicher Key im Cooldown-Fenster = kein Versand. */
    dedupKey: text("dedup_key").notNull(),
    finalScore: integer("final_score"),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alerts_dedup_idx").on(t.dedupKey, t.createdAt)],
);

export const emailAlerts = pgTable("email_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id")
    .notNull()
    .references(() => alerts.id, { onDelete: "cascade" }),
  template: text("template").notNull(),
  toAddress: text("to_address").notNull(),
  providerMessageId: text("provider_message_id"),
  status: text("status", { enum: ["queued", "sent", "failed"] }).notNull().default("queued"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

/**
 * Einmal-Tokens fuer den INVEST-NOW-Button.
 *
 * Gespeichert wird ausschliesslich der SHA-256-Hash — der Klartext existiert nur
 * in der E-Mail. Der Token identifiziert einen Intent, er autorisiert nichts:
 * die Handlung braucht zusaetzlich eine eingeloggte Session. Wer die Mail
 * abfaengt, kann damit nichts ausloesen.
 */
export const manualTradeTokens = pgTable(
  "manual_trade_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    intentId: uuid("intent_id")
      .notNull()
      .references(() => tradeIntents.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("manual_trade_tokens_intent_idx").on(t.intentId)],
);

export const reconciliationEvents = pgTable(
  "reconciliation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id").references(() => positions.id),
    signature: text("signature"),
    kind: text("kind", {
      enum: [
        "SIGNATURE_RESOLVED",
        "BALANCE_DRIFT",
        "ORPHAN_ON_CHAIN_POSITION",
        "MISSING_ON_CHAIN_POSITION",
      ],
    }).notNull(),
    expected: jsonb("expected").notNull().default({}),
    actual: jsonb("actual").notNull().default({}),
    resolved: text("resolved", { enum: ["pending", "auto", "manual"] }).notNull().default("pending"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reconciliation_time_idx").on(t.at)],
);

/** Audit-Trail: Modus-Wechsel, Deploys, Konfigurationsaenderungen, Emergency Stop. */
export const systemEvents = pgTable(
  "system_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    detail: jsonb("detail").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("system_events_time_idx").on(t.at)],
);

export const backtestRuns = pgTable("backtest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyVersionId: uuid("strategy_version_id")
    .notNull()
    .references(() => strategyVersions.id),
  /** Reproduzierbarkeit: gleicher Commit + gleiche Daten = gleiches Ergebnis. */
  codeCommitHash: text("code_commit_hash").notNull(),
  costModelVersion: text("cost_model_version").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  phase: text("phase", { enum: ["training", "validation", "out_of_sample"] }).notNull(),
  metrics: jsonb("metrics").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backtestTrades = pgTable(
  "backtest_trades",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => backtestRuns.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => tokens.id),
    entryAt: timestamp("entry_at", { withTimezone: true }).notNull(),
    exitAt: timestamp("exit_at", { withTimezone: true }),
    netPnlMinor: bigint("net_pnl_minor", { mode: "bigint" }),
    costsMinor: bigint("costs_minor", { mode: "bigint" }),
    exitReason: text("exit_reason"),
  },
  (t) => [index("backtest_trades_run_idx").on(t.runId)],
);
