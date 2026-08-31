/**
 * Wiederholung mit Backoff — und einer harten Obergrenze.
 *
 * Die Obergrenze ist der eigentliche Zweck. Ein Retry ohne Deckel ist bei einem
 * gesperrten Anbieter keine Robustheit, sondern ein Dauerlauf gegen eine Wand:
 * er erzeugt Last, verbraucht Rate-Limit-Budget fuer den Moment, in dem der
 * Anbieter wiederkommt, und verdeckt in den Logs alles andere.
 *
 * Zwei Regeln, die daraus folgen:
 *
 * 1. **Nicht jeder Fehler ist wiederholbar.** Ein 422 wird beim zweiten Versuch
 *    wieder ein 422. Wiederholt wird nur, was sich von selbst aendern kann.
 * 2. **Eine Netzsperre wird gar nicht wiederholt.** Sie aendert sich nicht
 *    dadurch, dass man wartet, sondern durch eine Freigabe. Der Versuch gehoert
 *    dem Scheduler mit seinem langen Takt, nicht der Retry-Schleife.
 */

import type { FailureClass } from "@sae/providers";

export interface BackoffPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Anteil zufaelliger Streuung, 0..1. Verhindert Thundering Herd. */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  maxAttempts: 4,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitter: 0.2,
};

/** Kein Backoff, der laenger dauert als das Interval des Schedulers. */
export const HARD_MAX_DELAY_MS = 300_000;

export function backoffDelayMs(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (attempt < 1) throw new RangeError(`attempt beginnt bei 1, war ${attempt}`);
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs, HARD_MAX_DELAY_MS);
  const spread = capped * policy.jitter;
  return Math.round(capped - spread / 2 + random() * spread);
}

export type RetryDecision =
  | { readonly kind: "RETRY"; readonly afterMs: number; readonly attempt: number }
  | { readonly kind: "GIVE_UP"; readonly reason: string };

/** Fehlerklassen, die sich durch Warten aendern koennen. */
const RETRYABLE: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "UNAVAILABLE",
  "RATE_LIMITED",
  "UNKNOWN",
]);

export function isRetryable(failure: FailureClass): boolean {
  return RETRYABLE.has(failure);
}

export function decideRetry(input: {
  readonly attempt: number;
  readonly failure: FailureClass;
  readonly policy?: BackoffPolicy;
  readonly random?: () => number;
}): RetryDecision {
  const policy = input.policy ?? DEFAULT_BACKOFF;

  if (input.failure === "BLOCKED") {
    return {
      kind: "GIVE_UP",
      reason:
        "Netzsperre aendert sich nicht durch Warten — der naechste Versuch gehoert dem Scheduler.",
    };
  }
  if (!isRetryable(input.failure)) {
    return { kind: "GIVE_UP", reason: `${input.failure} wiederholt sich unveraendert.` };
  }
  if (input.attempt >= policy.maxAttempts) {
    return {
      kind: "GIVE_UP",
      reason: `${policy.maxAttempts} Versuche erschoepft.`,
    };
  }

  return {
    kind: "RETRY",
    afterMs: backoffDelayMs(input.attempt, policy, input.random),
    attempt: input.attempt + 1,
  };
}
