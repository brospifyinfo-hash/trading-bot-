import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";
import { users } from "./identity";

export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Unveraenderlich.
 *
 * Eine Parameteraenderung erzeugt IMMER eine neue Zeile. Wuerde man in-place
 * aendern, waere jede zurueckliegende Trade-Statistik nicht mehr einer bekannten
 * Konfiguration zuzuordnen — und damit wertlos.
 *
 * `activatedAt`/`activatedBy` sind getrennt vom Anlegen: eine Version zu
 * erstellen ist folgenlos, sie scharfzuschalten ist ein bewusster Akt.
 */
export const strategyVersions = pgTable(
  "strategy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "restrict" }),
    version: text("version").notNull(),
    parameters: jsonb("parameters").notNull(),
    reason: text("reason").notNull(),
    backtestRunId: uuid("backtest_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    activatedBy: uuid("activated_by").references(() => users.id),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [unique("strategy_versions_unique").on(t.strategyId, t.version)],
);

export const scores = pgTable(
  "scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    security: smallint("security"),
    liquidity: smallint("liquidity"),
    momentum: smallint("momentum"),
    smartMoney: smallint("smart_money"),
    social: smallint("social"),
    dev: smallint("dev"),
    holder: smallint("holder"),
    narrative: smallint("narrative"),
    manipulation: smallint("manipulation"),
    execution: smallint("execution"),
    finalScore: smallint("final_score").notNull(),
    scoreEngineVersion: text("score_engine_version").notNull(),
    /** Hash des Feature-Vektors — macht eine Entscheidung exakt reproduzierbar. */
    inputHash: text("input_hash").notNull(),
  },
  (t) => [index("scores_pit_idx").on(t.tokenId, t.observedAt)],
);

/** Vollstaendiger Feature-Vektor einer Entscheidung. Ermoeglicht Replay. */
export const decisionInputs = pgTable("decision_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenId: uuid("token_id")
    .notNull()
    .references(() => tokens.id, { onDelete: "cascade" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  features: jsonb("features").notNull(),
  inputHash: text("input_hash").notNull(),
  providerSetHash: text("provider_set_hash").notNull(),
});

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["ENTER", "WATCH", "REJECT"] }).notNull(),
    finalScore: smallint("final_score").notNull(),
    riskLevel: text("risk_level", { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }).notNull(),
    /** ESTIMATED oder UNKNOWN. UNKNOWN blockiert Auto-Trading. */
    evKind: text("ev_kind", { enum: ["ESTIMATED", "UNKNOWN"] }).notNull(),
    evPerUnit: doublePrecision("ev_per_unit"),
    evConfidence: doublePrecision("ev_confidence"),
    evSampleSize: integer("ev_sample_size"),
    dataCompleteness: doublePrecision("data_completeness").notNull(),
    reasons: jsonb("reasons").notNull().default([]),
    risks: jsonb("risks").notNull().default([]),
    scoreEngineVersion: text("score_engine_version").notNull(),
    strategyVersionId: uuid("strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("signals_token_time_idx").on(t.tokenId, t.decidedAt), index("signals_kind_idx").on(t.kind)],
);

/**
 * Jeder interessante, aber nicht gehandelte Token.
 *
 * Forschungsmaterial, kein Papierkorb: nur wer die Ablehnungen weiterverfolgt,
 * kann messen, ob sie richtig waren. Ohne diese Tabelle beruht jede
 * Faktoranalyse ausschliesslich auf Ueberlebenden.
 */
export const rejections = pgTable(
  "rejections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => tokens.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    detail: jsonb("detail").notNull().default({}),
    finalScore: smallint("final_score"),
    strategyVersionId: uuid("strategy_version_id").references(() => strategyVersions.id),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rejections_reason_idx").on(t.reason),
    index("rejections_time_idx").on(t.rejectedAt),
  ],
);
