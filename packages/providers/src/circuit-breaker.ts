import type { Clock } from "@sae/core";

/**
 * Circuit Breaker je Provider.
 *
 * Ein Anbieter, der reihenweise Fehler liefert, wird nicht weiter befragt — jeder
 * weitere Aufruf kostet Zeit und Kontingent und liefert nichts. Wichtiger noch:
 * ein offener Breaker macht den Ausfall SICHTBAR, statt ihn in Einzelfehlern zu
 * verstecken. Er ist damit ein Eingangssignal fuer die Hard Gates: ist eine
 * kritische Quelle offen, wird nicht eingestiegen.
 */
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #clock: Clock;
  #state: BreakerState = "CLOSED";
  #consecutiveFailures = 0;
  #openedAtMs: number | null = null;

  constructor(options: {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    readonly clock: Clock;
  }) {
    this.#failureThreshold = options.failureThreshold;
    this.#cooldownMs = options.cooldownMs;
    this.#clock = options.clock;
  }

  get state(): BreakerState {
    this.#maybeHalfOpen();
    return this.#state;
  }

  /** Darf ein Aufruf versucht werden? */
  allowsRequest(): boolean {
    return this.state !== "OPEN";
  }

  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#state = "CLOSED";
    this.#openedAtMs = null;
  }

  recordFailure(): void {
    this.#consecutiveFailures += 1;
    // Ein Fehlschlag im halboffenen Zustand oeffnet sofort wieder: der Anbieter
    // hat gerade bewiesen, dass er noch nicht zurueck ist.
    if (this.#state === "HALF_OPEN" || this.#consecutiveFailures >= this.#failureThreshold) {
      this.#state = "OPEN";
      this.#openedAtMs = this.#clock.now().getTime();
    }
  }

  #maybeHalfOpen(): void {
    if (this.#state !== "OPEN" || this.#openedAtMs === null) return;
    if (this.#clock.now().getTime() - this.#openedAtMs >= this.#cooldownMs) {
      this.#state = "HALF_OPEN";
    }
  }
}
