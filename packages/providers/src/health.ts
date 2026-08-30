import type { Clock } from "@sae/core";
import type { ProviderHealthState } from "./types";
import type { CircuitBreaker } from "./circuit-breaker";
import type { ProviderBudget } from "./budget";

/**
 * Gesundheitszustand eines Providers.
 *
 * Drei Stufen mit klarer Bedeutung fuer die Handelslogik:
 *   HEALTHY  — Daten dieses Providers duerfen eine Einstiegsentscheidung tragen.
 *   DEGRADED — nutzbar, aber die Datenvollstaendigkeit sinkt; ein Hard Gate kann greifen.
 *   DOWN     — liefert nichts Verwertbares. Ist er kritisch, wird nicht eingestiegen.
 *
 * "Zuletzt erfolgreich" ist bewusst Teil des Zustands: ein Provider, der seit
 * zehn Minuten nur Fehler liefert, ist nicht deshalb gesund, weil gerade niemand
 * ihn gefragt hat.
 */
export class HealthTracker {
  readonly #clock: Clock;
  readonly #windowSize: number;
  readonly #degradedErrorRate: number;
  readonly #maxSilenceMs: number;
  readonly #latencies: number[] = [];
  #outcomes: boolean[] = [];
  #lastSuccessAt: Date | null = null;
  #lastDetail: string | null = null;

  constructor(options: {
    readonly clock: Clock;
    readonly windowSize?: number;
    readonly degradedErrorRate?: number;
    /** Ohne Erfolg innerhalb dieser Zeit gilt der Provider als DOWN. */
    readonly maxSilenceMs?: number;
  }) {
    this.#clock = options.clock;
    this.#windowSize = options.windowSize ?? 50;
    this.#degradedErrorRate = options.degradedErrorRate ?? 0.2;
    this.#maxSilenceMs = options.maxSilenceMs ?? 300_000;
  }

  recordSuccess(latencyMs: number): void {
    this.#push(true);
    this.#latencies.push(latencyMs);
    if (this.#latencies.length > this.#windowSize) this.#latencies.shift();
    this.#lastSuccessAt = this.#clock.now();
    this.#lastDetail = null;
  }

  recordFailure(detail: string): void {
    this.#push(false);
    this.#lastDetail = detail;
  }

  get errorRate(): number {
    if (this.#outcomes.length === 0) return 0;
    return this.#outcomes.filter((ok) => !ok).length / this.#outcomes.length;
  }

  get latencyMsP95(): number | null {
    if (this.#latencies.length === 0) return null;
    const sorted = [...this.#latencies].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
    return sorted[rank - 1] ?? null;
  }

  state(options: { breaker?: CircuitBreaker; budget?: ProviderBudget } = {}): ProviderHealthState {
    const budgetUsedPct = options.budget ? options.budget.usedFraction * 100 : null;
    const base = {
      latencyMsP95: this.latencyMsP95,
      errorRate: this.errorRate,
      budgetUsedPct,
      lastSuccessAt: this.#lastSuccessAt,
    };

    if (options.breaker && options.breaker.state === "OPEN") {
      return { ...base, status: "DOWN", detail: this.#lastDetail ?? "Circuit Breaker offen" };
    }

    // Noch nie erfolgreich gewesen ist nicht dasselbe wie gesund.
    if (this.#outcomes.length > 0 && this.#lastSuccessAt === null) {
      return { ...base, status: "DOWN", detail: this.#lastDetail ?? "Kein einziger Erfolg" };
    }

    if (this.#lastSuccessAt !== null) {
      const silence = this.#clock.now().getTime() - this.#lastSuccessAt.getTime();
      if (silence > this.#maxSilenceMs) {
        return { ...base, status: "DOWN", detail: `Seit ${Math.round(silence / 1000)}s kein Erfolg` };
      }
    }

    if (options.budget?.exhausted) {
      // Kein Fehler, aber auch nicht mehr benutzbar: das Monatsbudget ist auf.
      return { ...base, status: "DEGRADED", detail: "Monatsbudget aufgebraucht" };
    }

    if (this.errorRate >= this.#degradedErrorRate) {
      return {
        ...base,
        status: "DEGRADED",
        detail: `Fehlerrate ${(this.errorRate * 100).toFixed(0)} %`,
      };
    }

    return { ...base, status: "HEALTHY", detail: null };
  }

  #push(ok: boolean): void {
    this.#outcomes.push(ok);
    if (this.#outcomes.length > this.#windowSize) this.#outcomes = this.#outcomes.slice(1);
  }
}
