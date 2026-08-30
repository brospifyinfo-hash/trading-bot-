/**
 * Zeit.
 *
 * Eine einzige, injizierbare Zeitquelle. Direkte `Date.now()`-Aufrufe in der
 * Domaenenlogik machen Tests nichtdeterministisch und Backtests unmoeglich —
 * dort muss "jetzt" der simulierte Zeitpunkt sein, nicht die Wanduhr.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Feste Zeit fuer Tests. `advance` erlaubt kontrolliertes Fortschreiten. */
export class FixedClock implements Clock {
  #current: Date;

  constructor(start: Date) {
    this.#current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(at: Date): void {
    this.#current = new Date(at.getTime());
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const ageMs = (at: Date, now: Date): number => now.getTime() - at.getTime();

export function isOlderThan(at: Date, now: Date, maxAgeMs: number): boolean {
  return ageMs(at, now) > maxAgeMs;
}

/** Nur fuer Logs und Anzeige. */
export function formatDuration(ms: number): string {
  if (ms < SECOND) return `${ms}ms`;
  if (ms < MINUTE) return `${(ms / SECOND).toFixed(1)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ${Math.floor((ms % MINUTE) / SECOND)}s`;
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`;
}
