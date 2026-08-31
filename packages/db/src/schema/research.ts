import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { strategyVersions } from "./strategy";

export const CANDIDATE_STATES = [
  "HYPOTHESIS",
  "BACKTESTED",
  "WALK_FORWARDED",
  "OUT_OF_SAMPLE_TESTED",
  "SHADOW_TRADING",
  "PROMOTED",
  "REJECTED",
  "SHELVED",
] as const;

export const CANDIDATE_ORIGINS = [
  "FEATURE_ANALYSIS",
  "REJECTION_ANALYSIS",
  "PARAMETER_VARIATION",
  "MANUAL",
] as const;

/**
 * Research-Batch mit eingefrorenen Zeitgrenzen.
 *
 * `frozen_at` und `boundary_hash` sind der Kern: sie machen nachpruefbar, dass
 * die Grenzen VOR der Hypothese standen (I-6). Deshalb bekommt die Tabelle in
 * der Migration `REVOKE UPDATE, DELETE` — eine nachtraeglich verschobene Grenze
 * waere nicht nur ein Fehler, sie waere unbemerkbar.
 *
 * `UNIQUE (boundary_hash)` setzt I-12 um: derselbe Datenbereich kann nicht
 * zweimal als eigener Batch gefuehrt werden und dieselbe Erkenntnis zweimal
 * bestaetigen.
 */
export const researchBatches = pgTable(
  "research_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trainFrom: timestamp("train_from", { withTimezone: true }).notNull(),
    trainTo: timestamp("train_to", { withTimezone: true }).notNull(),
    oosFrom: timestamp("oos_from", { withTimezone: true }).notNull(),
    oosTo: timestamp("oos_to", { withTimezone: true }).notNull(),
    /** Sperrfrist zwischen Training und Pruefung, mindestens die Haltedauer. */
    embargoSeconds: integer("embargo_seconds").notNull(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull(),
    boundaryHash: text("boundary_hash").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("research_batches_boundary_hash").on(t.boundaryHash),
    index("research_batches_train_idx").on(t.trainFrom, t.trainTo),
  ],
);

/**
 * Strategie-Kandidat.
 *
 * `research_batch_id` ist Pflicht. Eine Hypothese ohne Batch hat keine
 * eingefrorenen Zeitgrenzen — und dann laesst sich nicht mehr sagen, ob die
 * Out-of-Sample-Pruefung tatsaechlich ausserhalb lag.
 */
export const strategyCandidates = pgTable(
  "strategy_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    state: text("state", { enum: CANDIDATE_STATES }).notNull().default("HYPOTHESIS"),
    origin: text("origin", { enum: CANDIDATE_ORIGINS }).notNull(),
    researchBatchId: uuid("research_batch_id")
      .notNull()
      .references(() => researchBatches.id, { onDelete: "restrict" }),
    baseStrategyVersionId: uuid("base_strategy_version_id")
      .notNull()
      .references(() => strategyVersions.id),
    hypothesis: text("hypothesis").notNull(),
    parameters: jsonb("parameters").notNull(),
    /** Zeitpunkt der Hypothese. Muss nach `research_batches.frozen_at` liegen. */
    hypothesisAt: timestamp("hypothesis_at", { withTimezone: true }).notNull(),
    closedReason: text("closed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("strategy_candidates_state_idx").on(t.state),
    index("strategy_candidates_batch_idx").on(t.researchBatchId),
  ],
);

/**
 * Jeder Zustandswechsel eines Kandidaten, append-only.
 *
 * Ohne diese Tabelle liesse sich hinterher nicht sagen, ob eine Strategie die
 * Kette wirklich durchlaufen hat oder ob jemand den Zustand gesetzt hat.
 */
export const candidateTransitions = pgTable(
  "candidate_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => strategyCandidates.id, { onDelete: "cascade" }),
    fromState: text("from_state", { enum: CANDIDATE_STATES }).notNull(),
    toState: text("to_state", { enum: CANDIDATE_STATES }).notNull(),
    /** Kennzahlen, die den Uebergang getragen haben. */
    evidence: jsonb("evidence").notNull().default({}),
    reason: text("reason"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("candidate_transitions_candidate_idx").on(t.candidateId, t.at)],
);
