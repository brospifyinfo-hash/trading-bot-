import type { Clock } from "@sae/core";
import { classifyFailure, type FailureClass } from "@sae/providers";

import { runOnce, type IdempotencyStore } from "./idempotency";
import { decideRetry, type BackoffPolicy } from "./retry";

/**
 * Ein Job-Lauf: einmalig, begrenzt wiederholt, mit Zeitdeckel.
 *
 * Die drei Schutzmechanismen greifen in dieser Reihenfolge, und das ist wichtig:
 *
 *   1. Idempotenz   — wurde der Vorgang schon erledigt? Dann gar nicht erst laufen.
 *   2. Zeitdeckel   — ein haengender Aufruf blockiert sonst den Worker unbegrenzt.
 *   3. Wiederholung — nur bei Fehlern, die sich durch Warten aendern koennen.
 *
 * Umgekehrt waere es falsch: erst wiederholen und dann auf Idempotenz pruefen
 * hiesse, den Vorgang mehrfach auszufuehren und hinterher festzustellen, dass er
 * schon lief.
 */

export type JobOutcome<R> =
  | { readonly kind: "DONE"; readonly result: R; readonly attempts: number }
  | { readonly kind: "SKIPPED_DUPLICATE"; readonly result: R; readonly completedAt: Date }
  | { readonly kind: "IN_FLIGHT" }
  | {
      readonly kind: "FAILED";
      readonly attempts: number;
      readonly failure: FailureClass;
      readonly reason: string;
    };

export interface JobRunOptions<R> {
  readonly key: string;
  readonly clock: Clock;
  readonly store: IdempotencyStore<R>;
  readonly run: (attempt: number) => Promise<R>;
  readonly policy?: BackoffPolicy;
  /** Wartet die angegebene Zeit. Injizierbar, damit Tests nicht wirklich warten. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly random?: () => number;
}

/** Fehler mit einer erkennbaren Ursache, damit `decideRetry` entscheiden kann. */
export class JobError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
    readonly errorCode: string | null = null,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export class JobTimeoutError extends JobError {
  constructor(ms: number) {
    super(`Job hat ${ms} ms ueberschritten`, null, "ETIMEDOUT");
    this.name = "JobTimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureOf(error: unknown): FailureClass {
  if (error instanceof JobError) {
    return classifyFailure({
      httpStatus: error.httpStatus,
      errorCode: error.errorCode,
      message: error.message,
    });
  }
  return classifyFailure({ message: error instanceof Error ? error.message : String(error) });
}

export async function runJob<R>(options: JobRunOptions<R>): Promise<JobOutcome<R>> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempt = 1;
  let lastFailure: FailureClass = "UNKNOWN";
  let lastReason = "";

  const outcome = await runOnce<R>({
    store: options.store,
    key: options.key,
    clock: options.clock,
    fn: async () => {
      for (;;) {
        try {
          return await withTimeout(options.run(attempt), options.timeoutMs);
        } catch (error: unknown) {
          lastFailure = failureOf(error);
          lastReason = error instanceof Error ? error.message : String(error);
          const decision = decideRetry({
            attempt,
            failure: lastFailure,
            ...(options.policy !== undefined ? { policy: options.policy } : {}),
            ...(options.random !== undefined ? { random: options.random } : {}),
          });
          if (decision.kind === "GIVE_UP") throw error;
          await sleep(decision.afterMs);
          attempt = decision.attempt;
        }
      }
    },
  }).catch((error: unknown) => {
    lastReason = error instanceof Error ? error.message : String(error);
    return null;
  });

  if (outcome === null) {
    return { kind: "FAILED", attempts: attempt, failure: lastFailure, reason: lastReason };
  }
  if (outcome.kind === "IN_FLIGHT") return { kind: "IN_FLIGHT" };
  if (outcome.kind === "ALREADY_DONE") {
    return {
      kind: "SKIPPED_DUPLICATE",
      result: outcome.result,
      completedAt: outcome.completedAt,
    };
  }
  return { kind: "DONE", result: outcome.result, attempts: attempt };
}
