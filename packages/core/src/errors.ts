/**
 * Fehlertaxonomie.
 *
 * Die Klasse eines Fehlers bestimmt das Verhalten der Worker: wiederholbar,
 * endgueltig oder Policy-Verstoss. Ohne diese Unterscheidung wiederholt ein
 * Retry-Mechanismus auch Fehler, die sich nie von selbst aufloesen — im
 * Execution-Pfad heisst das im Zweifel: doppelt kaufen.
 */

export abstract class SaeError extends Error {
  abstract readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.context = Object.freeze({ ...context });
  }
}

/** Voruebergehend: Timeout, Rate Limit, kurzer Netzwerkausfall. Retry sinnvoll. */
export class RetryableError extends SaeError {
  override readonly retryable = true;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    context: Record<string, unknown> = {},
    retryAfterMs: number | null = null,
  ) {
    super(message, context);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Endgueltig: ungueltige Eingabe, unbekannter Token, abgelaufener Intent. Kein Retry. */
export class TerminalError extends SaeError {
  override readonly retryable = false;
}

/**
 * Eine Regel wurde verletzt — Hard Gate, Risikolimit, Signer-Policy.
 * Kein Fehler im technischen Sinn, sondern das System, das seine Aufgabe tut.
 */
export class PolicyViolation extends SaeError {
  override readonly retryable = false;
  readonly policy: string;

  constructor(policy: string, message: string, context: Record<string, unknown> = {}) {
    super(message, context);
    this.policy = policy;
  }
}

/** Ein verbotener Zustandsuebergang. Immer ein Programmierfehler. */
export class IllegalTransitionError extends SaeError {
  override readonly retryable = false;

  constructor(from: string, to: string, machine: string) {
    super(`Unzulaessiger Uebergang in ${machine}: ${from} -> ${to}`, { from, to, machine });
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SaeError && error.retryable;
}
