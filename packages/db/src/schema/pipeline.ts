import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Betriebszustand der Pipeline.
 *
 * Drei Tabellen, die alle demselben Zweck dienen: ein Worker, der abstuerzt,
 * darf beim Neustart weder Arbeit doppelt tun noch Arbeit verlieren.
 */

/**
 * Idempotenz-Register.
 *
 * `UNIQUE (job_key)` ist der eigentliche Mechanismus. Zwei Worker, die
 * gleichzeitig denselben Vorgang starten, entscheiden ihre Nebenlaeufigkeit
 * durch einen INSERT — nicht durch ein vorheriges SELECT, das genau zwischen
 * Lesen und Schreiben veraltet.
 */
export const jobExecutions = pgTable(
  "job_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobKey: text("job_key").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Ergebnis, damit ein Wiederholungslauf dasselbe zurueckgeben kann. */
    result: jsonb("result"),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("job_executions_key").on(t.jobKey),
    index("job_executions_open_idx").on(t.completedAt),
  ],
);

/**
 * Fortschritt langer Jobs.
 *
 * `done_units` ist bewusst eine Liste und kein Zaehler: bei einem Zaehler
 * haengt die Wiederaufnahme daran, dass die Reihenfolge beim zweiten Lauf
 * dieselbe ist — und das ist bei einer Discovery-Liste nie garantiert.
 */
export const jobCheckpoints = pgTable(
  "job_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobKey: text("job_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    doneUnits: jsonb("done_units").notNull().default([]),
    totalUnits: integer("total_units"),
  },
  (t) => [uniqueIndex("job_checkpoints_key").on(t.jobKey)],
);

export const PROVIDER_STATUSES = [
  "CONNECTED",
  "DEGRADED",
  "BLOCKED",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
] as const;

/**
 * Beobachteter Zustand eines Providers.
 *
 * Wird vom Worker geschrieben und vom Dashboard gelesen: die beiden Prozesse
 * reden nicht miteinander, und ein Statusfeld, das nur im Speicher des Workers
 * existiert, ist fuer die Anzeige nicht da.
 *
 * Append-only mit einer Zeile je Messung. Der Verlauf ist der interessante
 * Teil — „seit wann gesperrt" beantwortet keine Momentaufnahme.
 */
export const providerStatusSamples = pgTable(
  "provider_status_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status", { enum: PROVIDER_STATUSES }).notNull(),
    capabilities: jsonb("capabilities").notNull().default([]),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastFailureReason: text("last_failure_reason"),
    latencyMsP50: doublePrecision("latency_ms_p50"),
    latencyMsP95: doublePrecision("latency_ms_p95"),
    rateLimitRemaining: integer("rate_limit_remaining"),
    rateLimitLimit: integer("rate_limit_limit"),
    rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),
    dataFreshnessSeconds: doublePrecision("data_freshness_seconds"),
    detail: text("detail"),
  },
  (t) => [
    index("provider_status_provider_idx").on(t.providerId, t.observedAt),
    uniqueIndex("provider_status_unique").on(t.providerId, t.observedAt),
  ],
);
