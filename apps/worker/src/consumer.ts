import type { Logger } from "@sae/observability";
import { classifyFailure, type FailureClass } from "@sae/providers";
import { DEFAULT_BACKOFF, decideRetry, type BackoffPolicy } from "@sae/pipeline";
import type { ClaimedJob, JobQueueRepository } from "@sae/db";

/**
 * Consumer: zieht Auftraege, fuehrt sie aus, entscheidet ueber Wiederholung.
 *
 * Was dieser Consumer NICHT tut, ist ebenso wichtig wie das, was er tut:
 *
 * - Er haelt keinen Zustand im Speicher, der einen Neustart nicht ueberlebt.
 *   Alles, was zaehlt — Anspruch, Versuchszahl, Fehlergrund — steht in der
 *   Datenbank.
 * - Er wiederholt nicht in einer inneren Schleife. Eine Wiederholung geht
 *   zurueck in die Queue mit einem spaeteren `run_after`. Der Unterschied ist
 *   im Betrieb entscheidend: ein Prozess, der intern 60 Sekunden schlaeft,
 *   blockiert seinen Platz und ist bei einem Neustart weg.
 * - Er faengt keinen Fehler weg. Ein Auftrag, der endgueltig scheitert, landet
 *   sichtbar im Dead Letter.
 */

export type HandlerResult = unknown;

export interface JobHandler {
  /** Wird mit der Nutzlast des Auftrags aufgerufen. Wirft bei Fehlschlag. */
  handle(job: ClaimedJob): Promise<HandlerResult>;
}

export type HandlerRegistry = Readonly<Record<string, JobHandler>>;

export interface ConsumerOptions {
  readonly workerId: string;
  readonly queue: JobQueueRepository;
  readonly handlers: HandlerRegistry;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly policy?: BackoffPolicy;
  /** Nur diese Auftragsarten ziehen. Leer = alle. */
  readonly kinds?: readonly string[];
}

export interface ConsumerCycle {
  readonly claimed: number;
  readonly done: number;
  readonly retried: number;
  readonly dead: number;
  readonly reclaimed: number;
  readonly unhandled: number;
}

const DEFAULT_BATCH = 5;
const DEFAULT_LEASE_MS = 60_000;

function failureOf(error: unknown): FailureClass {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus =
    typeof error === "object" && error !== null && "httpStatus" in error
      ? ((error as { httpStatus: unknown }).httpStatus as number | null)
      : null;
  return classifyFailure({ httpStatus, message });
}

export class JobConsumer {
  readonly #o: ConsumerOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #stopping = false;

  constructor(options: ConsumerOptions) {
    this.#o = options;
  }

  /**
   * Ein Durchlauf: Fristen einsammeln, Auftraege ziehen, ausfuehren.
   *
   * Die Rueckgabe der abgelaufenen Fristen steht VOR dem Ziehen. Sonst zieht
   * dieser Worker neue Arbeit, waehrend Auftraege eines abgestuerzten Workers
   * unberuehrt liegen bleiben — und die aeltesten Auftraege waeren die, die am
   * laengsten warten.
   */
  async cycle(): Promise<ConsumerCycle> {
    const now = this.#o.now();
    const reclaimed = await this.#o.queue.reclaimExpired(now);
    if (reclaimed.length > 0) {
      this.#o.logger.warn(
        { count: reclaimed.length },
        "Auftraege mit abgelaufener Frist zurueckgegeben",
      );
    }

    const claimed = await this.#o.queue.claim({
      workerId: this.#o.workerId,
      limit: this.#o.batchSize ?? DEFAULT_BATCH,
      now,
      leaseMs: this.#o.leaseMs ?? DEFAULT_LEASE_MS,
      ...(this.#o.kinds !== undefined ? { kinds: this.#o.kinds } : {}),
    });

    let done = 0;
    let retried = 0;
    let dead = 0;
    let unhandled = 0;

    for (const job of claimed) {
      const handler = this.#o.handlers[job.kind];
      if (handler === undefined) {
        // Ein Auftrag ohne Handler ist ein Konfigurationsfehler, kein
        // Uebertragungsproblem: Wiederholen aendert nichts.
        unhandled += 1;
        await this.#o.queue.fail({
          jobId: job.id,
          error: `Kein Handler fuer Auftragsart ${job.kind}`,
          failureClass: "NO_HANDLER",
          retryable: false,
          retryAfterMs: 0,
          at: this.#o.now(),
        });
        dead += 1;
        this.#o.logger.error({ kind: job.kind, jobId: job.id }, "Auftrag ohne Handler");
        continue;
      }

      try {
        const result = await handler.handle(job);
        await this.#o.queue.complete({ jobId: job.id, result, at: this.#o.now() });
        done += 1;
      } catch (error: unknown) {
        const failure = failureOf(error);
        const message = error instanceof Error ? error.message : String(error);
        const decision = decideRetry({
          attempt: job.attempts,
          failure,
          policy: this.#o.policy ?? DEFAULT_BACKOFF,
        });
        const outcome = await this.#o.queue.fail({
          jobId: job.id,
          error: message,
          failureClass: failure,
          retryable: decision.kind === "RETRY",
          retryAfterMs: decision.kind === "RETRY" ? decision.afterMs : 0,
          at: this.#o.now(),
        });
        if (outcome?.kind === "RETRY") {
          retried += 1;
          this.#o.logger.warn(
            { jobId: job.id, kind: job.kind, attempts: job.attempts, failure },
            "Auftrag wird wiederholt",
          );
        } else {
          dead += 1;
          this.#o.logger.error(
            { jobId: job.id, kind: job.kind, attempts: job.attempts, failure, message },
            "Auftrag endgueltig gescheitert (Dead Letter)",
          );
        }
      }
    }

    return { claimed: claimed.length, done, retried, dead, reclaimed: reclaimed.length, unhandled };
  }

  start(intervalMs = 1_000): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      // Ueberlappende Durchlaeufe werden uebersprungen: sonst zieht ein
      // langsamer Handler beliebig viele Auftraege parallel.
      if (this.#busy || this.#stopping) return;
      this.#busy = true;
      void this.cycle()
        .catch((error: unknown) => {
          this.#o.logger.error(
            { error: error instanceof Error ? error.message : String(error) },
            "Consumer-Durchlauf fehlgeschlagen",
          );
        })
        .finally(() => {
          this.#busy = false;
        });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    // Auf den laufenden Durchlauf warten: ein Abbruch mitten in einem Handler
    // laesst den Auftrag bis zum Fristablauf in RUNNING stehen.
    for (let i = 0; this.#busy && i < 300; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}
