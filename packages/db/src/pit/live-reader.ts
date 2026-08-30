import type { Clock } from "@sae/core";
import type { Database } from "../client";
import { PostgresPitReader } from "./postgres-reader";
import type { PitReader, PitSecurity, PitSnapshot } from "./reader";

/**
 * Live-Zugriff.
 *
 * Bindet `asOf` an die Uhr, damit Live-Code keinen Zeitpunkt erfindet. Der
 * darunterliegende Filter bleibt derselbe — auch im Livebetrieb gilt
 * `observed_at <= now`, denn Daten aus der Zukunft sind auch dort ein Fehler
 * (etwa ein Provider mit falsch gesetzter Uhr).
 */
export class LivePitReader implements PitReader {
  readonly mode = "live" as const;
  readonly #inner: PostgresPitReader;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#inner = new PostgresPitReader(db, "live");
    this.#clock = clock;
  }

  snapshotAt(tokenId: string, asOf: Date = this.#clock.now()): Promise<PitSnapshot | null> {
    return this.#inner.snapshotAt(tokenId, asOf);
  }

  snapshotsBetween(
    tokenId: string,
    from: Date,
    asOf: Date = this.#clock.now(),
  ): Promise<PitSnapshot[]> {
    return this.#inner.snapshotsBetween(tokenId, from, asOf);
  }

  securityAt(tokenId: string, asOf: Date = this.#clock.now()): Promise<PitSecurity | null> {
    return this.#inner.securityAt(tokenId, asOf);
  }

  smartMoneyQualifiedAt(asOf: Date = this.#clock.now()): Promise<string[]> {
    return this.#inner.smartMoneyQualifiedAt(asOf);
  }
}

/** Backtest-Zugriff. `asOf` ist hier immer die Simulationszeit. */
export function createBacktestPitReader(db: Database): PitReader {
  return new PostgresPitReader(db, "backtest");
}
