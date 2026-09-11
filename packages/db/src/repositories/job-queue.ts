import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from "drizzle-orm";
import type { JobDispatcher, JobRequest } from "@sae/pipeline";

import { asDate } from "../coerce";
import type { Database } from "../client";
import { jobQueue, jobQueueHistory, type JobState } from "../schema/queue";

/**
 * Dauerhafte Queue: Producer, Consumer, Wiederholung, Dead Letter.
 *
 * Drei Entwurfsentscheidungen, die den Unterschied zu einer Liste im Speicher
 * ausmachen:
 *
 * 1. **Beanspruchen statt Auslesen.** `claim` ist ein UPDATE mit
 *    `FOR UPDATE SKIP LOCKED` im Unterabfrage-Teil. Zwei Consumer, die
 *    gleichzeitig ziehen, bekommen verschiedene Auftraege — ohne Absprache und
 *    ohne Sperre auf Anwendungsebene.
 *
 * 2. **Frist statt Vertrauen.** Ein beanspruchter Auftrag traegt `lease_until`.
 *    Stirbt der Worker, laeuft die Frist ab und `reclaimExpired` gibt den
 *    Auftrag zurueck in die Queue. Ohne das bliebe er fuer immer RUNNING.
 *
 * 3. **Erledigte Schluessel ueberleben die Zeile.** `job_queue_history` haelt
 *    fest, dass ein Vorgang lief, auch nachdem die Queue-Zeile aufgeraeumt
 *    wurde. Sonst wuerde ein Aufraeumlauf die Idempotenz aufheben.
 */

export interface ClaimedJob {
  readonly id: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly enqueuedAt: Date;
}

export type EnqueueResult =
  | { readonly kind: "ENQUEUED"; readonly jobId: string }
  /** Derselbe Auftrag liegt schon offen in der Queue. */
  | { readonly kind: "DUPLICATE" }
  /** Derselbe Auftrag wurde bereits abgeschlossen — er darf nicht erneut laufen. */
  | { readonly kind: "ALREADY_DONE"; readonly finishedAt: Date };

export interface FailResult {
  /** RETRY: zurueck in die Queue. DEAD: endgueltig gescheitert. */
  readonly kind: "RETRY" | "DEAD";
  readonly attempts: number;
  readonly runAfter?: Date;
}

export interface QueueStats {
  readonly queued: number;
  readonly running: number;
  readonly dead: number;
  readonly oldestQueuedAt: Date | null;
}

export interface EnqueueInput {
  readonly kind: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  readonly at: Date;
  readonly runAfter?: Date;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

/** Was im `result` eines zurueckgezogenen Auftrags steht. */
const SUPERSEDED_RESULT = {
  status: "SUPERSEDED",
  reason: "Ein neuerer Auftrag derselben Art mit derselben Nutzlast lag in der Queue.",
} as const;

export class JobQueueRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    // Ein bereits abgeschlossener Vorgang wird nicht wiederbelebt. Die Pruefung
    // steht vor dem INSERT, weil der partielle Unique-Index nur offene Zeilen
    // abdeckt und einen erledigten Schluessel durchliesse.
    const [done] = await this.db
      .select({ finishedAt: jobQueueHistory.finishedAt })
      .from(jobQueueHistory)
      .where(eq(jobQueueHistory.dedupeKey, input.dedupeKey))
      .limit(1);
    if (done !== undefined) return { kind: "ALREADY_DONE", finishedAt: done.finishedAt };

    const inserted = await this.db
      .insert(jobQueue)
      .values({
        kind: input.kind,
        payload: input.payload ?? {},
        dedupeKey: input.dedupeKey,
        enqueuedAt: input.at,
        runAfter: input.runAfter ?? input.at,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      })
      // Der partielle Unique-Index entscheidet die Nebenlaeufigkeit, nicht ein
      // vorheriges SELECT.
      .onConflictDoNothing()
      .returning({ id: jobQueue.id });

    const row = inserted[0];
    if (row === undefined) return { kind: "DUPLICATE" };
    return { kind: "ENQUEUED", jobId: row.id };
  }

  /**
   * Beansprucht bis zu `limit` faellige Auftraege fuer diesen Worker.
   *
   * `SKIP LOCKED` ist der Kern: ein Consumer ueberspringt Zeilen, die ein
   * anderer gerade beansprucht, statt auf sie zu warten. Damit skaliert die
   * Queue ueber mehrere Prozesse, ohne dass sie sich gegenseitig blockieren.
   */
  async claim(input: {
    readonly workerId: string;
    readonly kinds?: readonly string[];
    readonly limit: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<readonly ClaimedJob[]> {
    const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
    const kinds = input.kinds ?? [];

    const ready = this.db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.state, "QUEUED"),
          lte(jobQueue.runAfter, input.now),
          kinds.length === 0 ? undefined : inArray(jobQueue.kind, [...kinds]),
        ),
      )
      .orderBy(asc(jobQueue.priority), asc(jobQueue.runAfter))
      .limit(input.limit)
      // Der entscheidende Zusatz: ein Consumer ueberspringt gesperrte Zeilen,
      // statt auf sie zu warten.
      .for("update", { skipLocked: true });

    const rows = await this.db
      .update(jobQueue)
      .set({
        state: "RUNNING",
        claimedBy: input.workerId,
        leaseUntil,
        startedAt: input.now,
        attempts: sql`${jobQueue.attempts} + 1`,
      })
      .where(inArray(jobQueue.id, ready))
      .returning({
        id: jobQueue.id,
        kind: jobQueue.kind,
        payload: jobQueue.payload,
        dedupeKey: jobQueue.dedupeKey,
        attempts: jobQueue.attempts,
        maxAttempts: jobQueue.maxAttempts,
        enqueuedAt: jobQueue.enqueuedAt,
      });

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      dedupeKey: r.dedupeKey,
      attempts: r.attempts,
      maxAttempts: r.maxAttempts,
      enqueuedAt: r.enqueuedAt,
    }));
  }

  /** Erfolgreich beendet. Schluessel wandert in die Historie. */
  async complete(input: {
    readonly jobId: string;
    readonly result?: unknown;
    readonly at: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(jobQueue)
        .set({
          state: "DONE",
          finishedAt: input.at,
          leaseUntil: null,
          result: input.result === undefined ? null : input.result,
        })
        // Nur der Worker, der ihn haelt, darf ihn abschliessen: ein Auftrag, der
        // schon per Frist zurueckgegeben wurde, gehoert jemand anderem.
        .where(and(eq(jobQueue.id, input.jobId), eq(jobQueue.state, "RUNNING")))
        .returning({
          dedupeKey: jobQueue.dedupeKey,
          kind: jobQueue.kind,
          attempts: jobQueue.attempts,
        });

      const row = updated[0];
      if (row === undefined) return false;
      await tx
        .insert(jobQueueHistory)
        .values({
          dedupeKey: row.dedupeKey,
          kind: row.kind,
          state: "DONE",
          attempts: row.attempts,
          finishedAt: input.at,
        })
        .onConflictDoNothing();
      return true;
    });
  }

  /**
   * Fehlgeschlagen: entweder zurueck in die Queue oder ins Dead Letter.
   *
   * `retryable = false` beendet sofort. Ein 422 wird beim zweiten Versuch
   * wieder ein 422, und eine Netzsperre aendert sich nicht durch Warten.
   */
  async fail(input: {
    readonly jobId: string;
    readonly error: string;
    readonly failureClass: string;
    readonly retryable: boolean;
    readonly retryAfterMs: number;
    readonly at: Date;
  }): Promise<FailResult | null> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          attempts: jobQueue.attempts,
          maxAttempts: jobQueue.maxAttempts,
          dedupeKey: jobQueue.dedupeKey,
          kind: jobQueue.kind,
          state: jobQueue.state,
        })
        .from(jobQueue)
        .where(eq(jobQueue.id, input.jobId))
        .limit(1);
      if (current === undefined || current.state !== "RUNNING") return null;

      const exhausted = current.attempts >= current.maxAttempts;
      if (!input.retryable || exhausted) {
        await tx
          .update(jobQueue)
          .set({
            state: "DEAD",
            finishedAt: input.at,
            leaseUntil: null,
            lastError: input.error,
            lastFailureClass: input.failureClass,
          })
          .where(eq(jobQueue.id, input.jobId));
        await tx
          .insert(jobQueueHistory)
          .values({
            dedupeKey: current.dedupeKey,
            kind: current.kind,
            state: "DEAD",
            attempts: current.attempts,
            finishedAt: input.at,
            lastError: input.error,
          })
          .onConflictDoNothing();
        return { kind: "DEAD" as const, attempts: current.attempts };
      }

      const runAfter = new Date(input.at.getTime() + input.retryAfterMs);
      await tx
        .update(jobQueue)
        .set({
          state: "QUEUED",
          claimedBy: null,
          leaseUntil: null,
          startedAt: null,
          runAfter,
          lastError: input.error,
          lastFailureClass: input.failureClass,
        })
        .where(eq(jobQueue.id, input.jobId));
      return { kind: "RETRY" as const, attempts: current.attempts, runAfter };
    });
  }

  /**
   * Gibt Auftraege verstorbener Worker zurueck in die Queue.
   *
   * Der Versuchszaehler wird NICHT zurueckgesetzt: ein Auftrag, der den Worker
   * dreimal mitgerissen hat, ist ein Verdacht und kein Zufall. Ohne den Zaehler
   * liefe er endlos im Kreis.
   */
  async reclaimExpired(now: Date, limit = 100): Promise<readonly string[]> {
    const expired = this.db
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.state, "RUNNING"),
          isNotNull(jobQueue.leaseUntil),
          lt(jobQueue.leaseUntil, now),
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });

    const rows = await this.db
      .update(jobQueue)
      .set({
        // Erschoepfte Versuche fuehren direkt ins Dead Letter, sonst laeuft ein
        // Auftrag, der jeden Worker mitreisst, endlos im Kreis.
        state: sql`case when ${jobQueue.attempts} >= ${jobQueue.maxAttempts} then 'DEAD' else 'QUEUED' end`,
        claimedBy: null,
        leaseUntil: null,
        startedAt: null,
        // Zwei Dinge sind hier noetig, und beide aus einem echten Fehlschlag
        // gelernt:
        //
        // 1. Der Cast: ohne ihn leitet Postgres den Typ des CASE-Ausdrucks aus
        //    dem ungetypten Parameter ab und bekommt text.
        // 2. `toISOString()`: ein Date direkt in ein sql-Fragment zu binden
        //    laeuft unter PGlite durch, aber postgres-js — der Treiber im
        //    Betrieb — bricht mit "Received an instance of Date" ab. Der Fehler
        //    trat deshalb in keinem Test auf, sondern erst im laufenden
        //    Consumer.
        finishedAt: sql`case when ${jobQueue.attempts} >= ${jobQueue.maxAttempts} then ${now.toISOString()}::timestamptz else null::timestamptz end`,
        lastError: "Worker hat die Frist ueberschritten (lease expired)",
        lastFailureClass: "LEASE_EXPIRED",
      })
      .where(inArray(jobQueue.id, expired))
      .returning({ id: jobQueue.id });
    return rows.map((r) => r.id);
  }

  /**
   * Ueberholte Takte zurueckziehen.
   *
   * Periodische Auftraege sind Momentaufnahmen: „hol die aktuellen Marktdaten",
   * „such neue Tokens", „miss die Anbieter". Liegen davon fuenf gleiche in der
   * Queue, weil laengere Zeit niemand abgearbeitet hat, dann ist der aelteste
   * NICHT vier Arbeitsschritte wert — er wuerde exakt dieselbe Arbeit tun wie
   * der neueste, nur vier Mal zusaetzlich und auf Kosten des Anbieterbudgets.
   *
   * Der Anlass war ein gemessener: 9424 offene Auftraege, angesammelt in rund
   * neun Stunden, in denen der Scheduler einreihte und kein Consumer lief.
   * Haette der erste Consumer die einfach abgearbeitet, waeren daraus rund
   * zweitausend DexScreener-Anfragen in wenigen Minuten geworden — direkt in
   * die Drosselung, und der erste echte Lauf des Systems haette wie ein Defekt
   * ausgesehen.
   *
   * Die Regel ist bewusst nicht „aelter als X Minuten": eine Zeitschwelle
   * muesste je Takt anders sein (zehn Sekunden bis sechs Stunden) und waere
   * damit eine zweite Stelle, an der Taktintervalle gepflegt werden. Statt
   * dessen die Aussage, um die es tatsaechlich geht: **existiert ein neuerer
   * Auftrag derselben Art mit derselben Nutzlast, ist der aeltere ueberholt.**
   * Genau einer je (Art, Nutzlast) bleibt stehen, und zwar der neueste.
   *
   * Die Nutzlast gehoert in den Vergleich: bei tokenbezogenen Auftraegen
   * (`SCORE_TOKEN` mit einem Mint) waeren sonst verschiedene Tokens
   * „dieselbe Arbeit". `jsonb` vergleicht schluesselordnungsunabhaengig.
   *
   * Zustand `DONE` und nicht `DEAD`: hier ist nichts fehlgeschlagen. Das Dead
   * Letter mit tausenden Nicht-Fehlern zu fuellen wuerde die echten darin
   * unsichtbar machen. Das `result` sagt, was passiert ist — verschwinden tut
   * der Auftrag nicht.
   */
  async retireSuperseded(at: Date, limit = 2_000): Promise<number> {
    return this.db.transaction(async (tx) => {
      const veraltet = tx
        .select({ id: jobQueue.id })
        .from(jobQueue)
        .where(
          and(
            eq(jobQueue.state, "QUEUED"),
            sql`exists (
              select 1 from job_queue as neuer
              where neuer.state = 'QUEUED'
                and neuer.kind = ${jobQueue.kind}
                and neuer.payload = ${jobQueue.payload}
                and (neuer.enqueued_at, neuer.id) > (${jobQueue.enqueuedAt}, ${jobQueue.id})
            )`,
          ),
        )
        .orderBy(asc(jobQueue.enqueuedAt))
        .limit(limit)
        .for("update", { skipLocked: true });

      const rows = await tx
        .update(jobQueue)
        .set({
          state: "DONE",
          finishedAt: at,
          leaseUntil: null,
          result: SUPERSEDED_RESULT,
        })
        // Der Zustand steht ein zweites Mal in der Bedingung: zwischen Auswahl
        // und Update kann ein anderer Worker denselben Auftrag beansprucht
        // haben. `skipLocked` macht das unwahrscheinlich, nicht unmoeglich.
        .where(and(inArray(jobQueue.id, veraltet), eq(jobQueue.state, "QUEUED")))
        .returning({
          dedupeKey: jobQueue.dedupeKey,
          kind: jobQueue.kind,
          attempts: jobQueue.attempts,
        });

      if (rows.length > 0) {
        // Auch der zurueckgezogene Takt gehoert in die Historie: sein
        // Fensterschluessel darf nicht erneut eingereiht werden.
        await tx
          .insert(jobQueueHistory)
          .values(
            rows.map((r) => ({
              dedupeKey: r.dedupeKey,
              kind: r.kind,
              state: "DONE" as const,
              attempts: r.attempts,
              finishedAt: at,
            })),
          )
          .onConflictDoNothing();
      }

      return rows.length;
    });
  }

  /** Verlaengert die Frist eines laufenden Auftrags (Heartbeat). */
  async extendLease(jobId: string, until: Date): Promise<boolean> {
    const updated = await this.db
      .update(jobQueue)
      .set({ leaseUntil: until })
      .where(and(eq(jobQueue.id, jobId), eq(jobQueue.state, "RUNNING")))
      .returning({ id: jobQueue.id });
    return updated.length > 0;
  }

  async deadLetters(limit = 50): Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly dedupeKey: string;
      readonly attempts: number;
      readonly lastError: string | null;
      readonly finishedAt: Date | null;
    }[]
  > {
    return this.db
      .select({
        id: jobQueue.id,
        kind: jobQueue.kind,
        dedupeKey: jobQueue.dedupeKey,
        attempts: jobQueue.attempts,
        lastError: jobQueue.lastError,
        finishedAt: jobQueue.finishedAt,
      })
      .from(jobQueue)
      .where(eq(jobQueue.state, "DEAD"))
      .orderBy(asc(jobQueue.finishedAt))
      .limit(limit);
  }

  async stats(now: Date): Promise<QueueStats> {
    const rows = await this.db
      .select({
        state: jobQueue.state,
        count: sql<number>`count(*)::int`,
        oldest: sql<Date | string | null>`min(${jobQueue.enqueuedAt})`,
      })
      .from(jobQueue)
      .where(inArray(jobQueue.state, ["QUEUED", "RUNNING", "DEAD"] satisfies JobState[]))
      .groupBy(jobQueue.state);

    const by = (s: JobState): number => rows.find((r) => r.state === s)?.count ?? 0;
    // Hier stand `new Date(oldest)` — jemand ist ueber genau dieses Problem
    // schon gestolpert und hat es an dieser einen Stelle umschifft. Das Wissen
    // hat die beiden Dashboard-Abfragen nie erreicht, und dort ist es im
    // Betrieb hochgegangen (§123). Jetzt benutzen alle drei denselben Weg.
    const oldest = asDate(rows.find((r) => r.state === "QUEUED")?.oldest);
    void now;
    return {
      queued: by("QUEUED"),
      running: by("RUNNING"),
      dead: by("DEAD"),
      oldestQueuedAt: oldest,
    };
  }
}

/**
 * Der Scheduler reicht seine Auftraege hier hinein.
 *
 * Bewusst die schmale Schnittstelle aus `@sae/pipeline`: der Scheduler kennt
 * die Datenbank nicht und ist ohne sie testbar.
 */
export class PostgresDispatcher implements JobDispatcher {
  readonly #queue: JobQueueRepository;

  constructor(db: Database) {
    this.#queue = new JobQueueRepository(db);
  }

  async enqueue(job: JobRequest): Promise<boolean> {
    const result = await this.#queue.enqueue({
      kind: job.kind,
      payload: job.payload,
      dedupeKey: job.dedupeKey,
      at: job.enqueuedAt,
    });
    return result.kind === "ENQUEUED";
  }
}
