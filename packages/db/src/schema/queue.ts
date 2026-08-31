import { sql } from "drizzle-orm";
import {
  check,
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
 * Dauerhafte Auftragsqueue.
 *
 * Warum in Postgres und nicht nur in Redis: die Queue traegt hier die
 * Zustellgarantie. Ein Auftrag, der eingereiht wurde, muss einen Neustart des
 * Workers, einen Absturz mitten in der Bearbeitung und einen Ausfall des
 * Redis-Knotens ueberleben. Redis bleibt sinnvoll als schneller Transport, ist
 * aber nicht die Quelle der Wahrheit.
 *
 * Zustaende und die Uebergaenge, die es gibt:
 *
 *   QUEUED  --claim-->  RUNNING  --ok-->        DONE
 *                          |     --retry-->     QUEUED   (attempts < max)
 *                          |     --give up-->   DEAD     (Dead Letter)
 *                          '     --lease exp--> QUEUED   (Worker gestorben)
 *
 * DEAD ist bewusst ein eigener Endzustand und kein geloeschter Datensatz: ein
 * Auftrag, der nicht durchlief, ist ein Betriebsereignis, das sichtbar bleiben
 * muss. Stilles Verschwinden ist die Fehlerart, die man erst Wochen spaeter an
 * einer Luecke in den Daten bemerkt.
 */

export const JOB_STATES = ["QUEUED", "RUNNING", "DONE", "DEAD"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const jobQueue = pgTable(
  "job_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /**
     * Fachlicher Schluessel des Auftrags.
     *
     * `UNIQUE` und teilweise: nur solange der Auftrag offen ist. Sonst koennte
     * derselbe Takt nie wieder laufen, weil der abgeschlossene Auftrag von
     * gestern den Schluessel dauerhaft belegt. Der Index steht in der Migration,
     * weil Drizzle keine partiellen Unique-Indizes ueber `where` erzeugt, die
     * hier greifen wuerden.
     */
    dedupeKey: text("dedupe_key").notNull(),
    state: text("state", { enum: JOB_STATES }).notNull().default("QUEUED"),
    priority: integer("priority").notNull().default(100),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    /** Vor diesem Zeitpunkt wird der Auftrag nicht angefasst — traegt den Backoff. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Bis wann der beanspruchende Worker als lebendig gilt.
     *
     * Laeuft die Frist ab, ohne dass er abgeschlossen hat, ist er gestorben und
     * der Auftrag wird erneut vergeben. Ohne diese Frist bliebe jeder Auftrag,
     * dessen Worker abstuerzt, fuer immer in RUNNING haengen.
     */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    lastError: text("last_error"),
    lastFailureClass: text("last_failure_class"),
    result: jsonb("result"),
  },
  (t) => [
    index("job_queue_ready_idx").on(t.state, t.runAfter, t.priority),
    index("job_queue_lease_idx").on(t.state, t.leaseUntil),
    index("job_queue_kind_idx").on(t.kind, t.enqueuedAt),
    check("job_queue_attempts_bounded", sql`attempts >= 0 and attempts <= max_attempts`),
    check(
      "job_queue_running_has_lease",
      sql`state <> 'RUNNING' or (lease_until is not null and claimed_by is not null)`,
    ),
    check(
      "job_queue_terminal_has_finish",
      sql`state in ('QUEUED','RUNNING') or finished_at is not null`,
    ),
    // Ein toter Auftrag ohne Begruendung ist im Betrieb wertlos.
    check("job_queue_dead_has_reason", sql`state <> 'DEAD' or last_error is not null`),
  ],
);

/**
 * Abgeschlossene Auftragsschluessel.
 *
 * Getrennt von `job_queue`, damit der aktive Teil der Queue klein bleibt und
 * die Wiedereinreihung trotzdem weiss, dass dieser Vorgang schon lief. Ein
 * Auftrag darf aus `job_queue` aufgeraeumt werden; sein Schluessel bleibt hier.
 */
export const jobQueueHistory = pgTable(
  "job_queue_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dedupeKey: text("dedupe_key").notNull(),
    kind: text("kind").notNull(),
    state: text("state", { enum: ["DONE", "DEAD"] }).notNull(),
    attempts: integer("attempts").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("job_queue_history_key").on(t.dedupeKey),
    index("job_queue_history_kind_idx").on(t.kind, t.finishedAt),
  ],
);
