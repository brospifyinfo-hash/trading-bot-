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
  /**
   * Ob dieser Handler die Arbeit seiner Auftragsart tatsaechlich tut.
   *
   * Der Anlass ist ein Fehler, den ich zweimal gemacht habe: in der
   * Worker-Matrix stand bei vier Rollen „READY — WAITING FOR DATA", und das
   * las sich wie „fertig, wartet nur auf Daten". Tatsaechlich zeigten ihre
   * Auftragsarten auf den allgemeinen Marktdaten-Handler, der Daten holt und
   * das Ergebnis wegwirft. Die Kette dahinter war gebaut, getestet — und
   * wurde ausschliesslich aus Tests aufgerufen.
   *
   * Eine von Hand gepflegte Statusangabe driftet. Diese hier kann es nicht:
   * sie steht an der Klasse, die die Arbeit tut oder eben nicht.
   */
  readonly wiring?: HandlerWiring;
}

export type HandlerWiring =
  /** Tut die Arbeit seiner Auftragsart. */
  | "DEDICATED"
  /**
   * Holt nur Marktdaten und verwirft das Ergebnis.
   *
   * Ein regulaerer Zwischenzustand, solange die Kette dahinter ohnehin am
   * Datentor endet — aber einer, der benannt gehoert und nicht als „fertig"
   * durchgehen darf.
   */
  | "MARKET_DATA_ONLY";

/**
 * Was die Auftragsarten heute tatsaechlich tun.
 *
 * Aus der Registrierung abgeleitet und nicht aufgeschrieben. Ein Handler, der
 * seine Einstufung nicht angibt, gilt als `MARKET_DATA_ONLY` — die
 * pessimistische Vorgabe, damit ein vergessenes Feld nicht wie eine
 * Fertigmeldung aussieht.
 */
export function describeWiring(registry: HandlerRegistry): Readonly<Record<string, HandlerWiring>> {
  const out: Record<string, HandlerWiring> = {};
  for (const [kind, handler] of Object.entries(registry)) {
    out[kind] = handler.wiring ?? "MARKET_DATA_ONLY";
  }
  return out;
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
  /** Ueberholte Takte, die zurueckgezogen statt ausgefuehrt wurden. */
  readonly superseded: number;
  readonly unhandled: number;
}

const DEFAULT_BATCH = 5;
const DEFAULT_LEASE_MS = 60_000;

/**
 * Wie oft abgelaufene Fristen gesucht werden.
 *
 * Die Frist selbst betraegt 60 Sekunden. Haeufiger zu suchen kann nichts
 * finden, was nicht auch beim naechsten Mal noch da waere — es kostet nur
 * Abfragen.
 */
const LEASE_SWEEP_MS = 30_000;

/** Wie oft ueberholte Takte zurueckgezogen werden. Aufraeumarbeit, keine Eile. */
const SUPERSEDE_SWEEP_MS = 60_000;

/** Ist die Wartung faellig? Beim ersten Mal immer. */
function due(last: number | null, now: Date, everyMs: number): boolean {
  return last === null || now.getTime() - last >= everyMs;
}

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
  /** Wann die Fristenpruefung zuletzt lief. `null` = noch nie. */
  #lastLeaseCheck: number | null = null;
  #lastSupersedeCheck: number | null = null;

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

    // Aufraeumen laeuft auf EIGENEM Takt, nicht bei jedem Durchlauf.
    //
    // Vorher liefen beide Abfragen jede Sekunde mit — zusammen mit `claim`
    // waren das drei Rundreisen zur Datenbank pro Sekunde, rund um die Uhr,
    // also ueber 250.000 am Tag im Leerlauf. Auf einer nach Datenmenge
    // abgerechneten Datenbank ist das kein Schoenheitsfehler, sondern die
    // Rechnung: das Kontingent war aufgebraucht, und der Worker kam nicht
    // mehr hoch.
    //
    // Sachlich war es ausserdem sinnlos. Fristen laufen 60 Sekunden — sie
    // sekuendlich zu pruefen kann nichts finden, was 30 Sekunden spaeter
    // nicht auch noch da waere. Und ueberholte Takte sind Aufraeumarbeit,
    // keine Eilsache.
    const reclaimed = await this.#maintainLeases(now);
    const superseded = await this.#retireSuperseded(now);

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

    return {
      claimed: claimed.length,
      done,
      retried,
      dead,
      reclaimed,
      superseded,
      unhandled,
    };
  }

  /**
   * Abgelaufene Fristen einsammeln — hoechstens alle `LEASE_SWEEP_MS`.
   *
   * Beim ersten Durchlauf laeuft sie sofort: nach einem Neustart koennen
   * Auftraege eines abgestuerzten Vorgaengers liegen, und die sollen nicht
   * eine halbe Minute warten.
   */
  async #maintainLeases(now: Date): Promise<number> {
    if (!due(this.#lastLeaseCheck, now, LEASE_SWEEP_MS)) return 0;
    this.#lastLeaseCheck = now.getTime();

    const reclaimed = await this.#o.queue.reclaimExpired(now);
    if (reclaimed.length > 0) {
      this.#o.logger.warn(
        { count: reclaimed.length },
        "Auftraege mit abgelaufener Frist zurueckgegeben",
      );
    }
    return reclaimed.length;
  }

  /**
   * Ueberholte Takte zurueckziehen — hoechstens alle `SUPERSEDE_SWEEP_MS`.
   *
   * Sie laeuft VOR dem Ziehen, wenn sie laeuft: sonst arbeitet der Durchlauf
   * ausgerechnet die aeltesten und damit ueberholten Auftraege ab, denn die
   * stehen in der Reihenfolge ganz vorn.
   */
  async #retireSuperseded(now: Date): Promise<number> {
    if (!due(this.#lastSupersedeCheck, now, SUPERSEDE_SWEEP_MS)) return 0;
    this.#lastSupersedeCheck = now.getTime();

    const superseded = await this.#o.queue.retireSuperseded(now);
    if (superseded > 0) {
      this.#o.logger.info(
        { superseded },
        "Ueberholte Takte zurueckgezogen — ein neuerer Auftrag derselben Art lag vor",
      );
    }
    return superseded;
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
