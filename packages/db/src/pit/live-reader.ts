import type { Clock } from "@sae/core";
import type { Database } from "../client";
import { PostgresPitReader } from "./postgres-reader";
import type { PitReader, PitSecurity, PitSnapshot } from "./reader";

/**
 * Live-Zugriff.
 *
 * Derselbe Filter wie im Backtest — auch im Livebetrieb gilt
 * `observed_at <= asOf`, denn Daten aus der Zukunft sind auch dort ein Fehler
 * (etwa ein Provider mit falsch gesetzter Uhr).
 *
 * `asOf` ist PFLICHT, auch hier. Eine fruehere Fassung hatte einen Defaultwert
 * aus der Uhr, und das war ein Loch in genau der Vorkehrung, um die es geht:
 * `PitReader` hat bewusst keine Methode, die „den aktuellen Stand" liefert,
 * damit ein Aufruf ohne Zeitpunkt ein Compile-Fehler ist. Ein Default-Argument
 * macht daraus wieder eine solche Methode — man sieht es dem Aufruf
 * `snapshotAt(tokenId)` nur nicht an.
 *
 * Wer den aktuellen Stand will, schreibt `reader.snapshotAt(id, reader.now())`.
 * Das ist eine Zeile mehr und an der Aufrufstelle sichtbar.
 */
export class LivePitReader implements PitReader {
  readonly mode = "live" as const;
  readonly #inner: PostgresPitReader;
  readonly #clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.#inner = new PostgresPitReader(db, "live");
    this.#clock = clock;
  }

  /** Aktuelle Zeit als ausdruecklicher `asOf`. Sichtbar an der Aufrufstelle. */
  now(): Date {
    return this.#clock.now();
  }

  async snapshotAt(tokenId: string, asOf: Date): Promise<PitSnapshot | null> {
    return this.#inner.snapshotAt(tokenId, asOf);
  }

  async snapshotsBetween(tokenId: string, from: Date, asOf: Date): Promise<PitSnapshot[]> {
    return this.#inner.snapshotsBetween(tokenId, from, asOf);
  }

  async securityAt(tokenId: string, asOf: Date): Promise<PitSecurity | null> {
    return this.#inner.securityAt(tokenId, asOf);
  }

  async smartMoneyQualifiedAt(asOf: Date): Promise<string[]> {
    return this.#inner.smartMoneyQualifiedAt(asOf);
  }
}

/** Backtest-Zugriff. `asOf` ist hier immer die Simulationszeit. */
export function createBacktestPitReader(db: Database): PitReader {
  return new PostgresPitReader(db, "backtest");
}
