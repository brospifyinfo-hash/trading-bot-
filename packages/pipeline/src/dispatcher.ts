import type { Clock } from "@sae/core";

import { idempotencyKey } from "./idempotency";
import type { CadenceId } from "./scheduler";

/**
 * Job-Einreihung als Schnittstelle.
 *
 * Der Scheduler soll Jobs einreihen, nicht sie ausfuehren — sonst laeuft alles
 * im selben Prozess und ein langsamer Handler blockiert den Takt. Die
 * Schnittstelle trennt beides und macht den Scheduler testbar, ohne dass eine
 * Queue laeuft.
 *
 * Der Auftragsschluessel entsteht aus Takt, Fachdaten und Zeitfenster. Damit
 * ist die Einreihung idempotent: derselbe Takt zweimal ausgeloest erzeugt
 * denselben Schluessel, und die Queue nimmt ihn nur einmal an.
 */

export type JobKind =
  | "DISCOVER_TOKENS"
  | "REFRESH_MARKET_DATA"
  | "SCORE_TOKEN"
  | "EVALUATE_OPPORTUNITY"
  | "MONITOR_PAPER_POSITION"
  | "EXPIRE_OPPORTUNITIES"
  | "SAMPLE_PROVIDER_HEALTH"
  | "RECONCILE"
  | "STRATEGY_HEALTH"
  | "RESEARCH_BATCH";

export interface JobRequest {
  readonly kind: JobKind;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  /** Eindeutig je fachlichem Vorgang. Zweimal eingereiht heisst einmal ausgefuehrt. */
  readonly dedupeKey: string;
  readonly enqueuedAt: Date;
}

export interface JobDispatcher {
  /** `false`, wenn derselbe Auftrag schon in der Queue liegt. */
  enqueue(job: JobRequest): Promise<boolean>;
}

/** Für Tests und den Einzelprozessbetrieb. */
export class InMemoryDispatcher implements JobDispatcher {
  readonly #seen = new Set<string>();
  readonly #jobs: JobRequest[] = [];

  async enqueue(job: JobRequest): Promise<boolean> {
    if (this.#seen.has(job.dedupeKey)) return false;
    this.#seen.add(job.dedupeKey);
    this.#jobs.push(job);
    return true;
  }

  get jobs(): readonly JobRequest[] {
    return this.#jobs;
  }

  drain(): readonly JobRequest[] {
    const out = [...this.#jobs];
    this.#jobs.length = 0;
    return out;
  }
}

/**
 * Zeitfenster, in dem ein Takt denselben Auftrag erzeugt.
 *
 * Ohne Fenster waere jeder Tick ein neuer Schluessel, und die Idempotenz
 * brächte nichts. Mit dem Takt-Intervall als Fenster erzeugt derselbe Takt
 * innerhalb seines Intervalls genau einen Auftrag — auch wenn der Scheduler
 * zweimal laeuft, etwa nach einem Neustart.
 */
export function cadenceWindow(now: Date, intervalMs: number): number {
  return Math.floor(now.getTime() / intervalMs);
}

export function jobRequest(input: {
  readonly kind: JobKind;
  readonly cadence: CadenceId;
  readonly intervalMs: number;
  readonly payload?: Readonly<Record<string, string | number | boolean | null>>;
  readonly clock: Clock;
}): JobRequest {
  const now = input.clock.now();
  const payload = input.payload ?? {};
  return {
    kind: input.kind,
    payload,
    dedupeKey: idempotencyKey("job", {
      kind: input.kind,
      cadence: input.cadence,
      window: cadenceWindow(now, input.intervalMs),
      ...payload,
    }),
    enqueuedAt: now,
  };
}

/** Welcher Auftrag zu welchem Takt gehoert. */
export const CADENCE_JOB: Readonly<Record<CadenceId, JobKind>> = {
  FAST_DISCOVERY: "DISCOVER_TOKENS",
  MARKET_UPDATE: "REFRESH_MARKET_DATA",
  POSITION_MONITOR: "RECONCILE",
  PAPER_MONITOR: "MONITOR_PAPER_POSITION",
  OPPORTUNITY_EXPIRY: "EXPIRE_OPPORTUNITIES",
  RESEARCH_BATCH: "RESEARCH_BATCH",
  STRATEGY_HEALTH: "STRATEGY_HEALTH",
  PROVIDER_HEALTH: "SAMPLE_PROVIDER_HEALTH",
  RECONCILIATION: "RECONCILE",
};
