/**
 * Point-in-Time-Zugriff.
 *
 * Die zentrale Vorkehrung gegen Look-Ahead: JEDE Methode verlangt `asOf`. Es gibt
 * bewusst KEINE Methode, die "den aktuellen Stand" liefert — waere sie vorhanden,
 * wuerde sie frueher oder spaeter im Backtest aufgerufen, und niemand saehe es dem
 * Ergebnis an. So ist der Fehler stattdessen ein Compile-Fehler.
 *
 * Feature-Builder bekommen ausschliesslich einen PitReader injiziert und haben
 * keinen eigenen Datenbankzugriff. Damit ist die Regel nicht mehr Disziplinsache.
 */

export interface PitSnapshot {
  readonly tokenId: string;
  readonly observedAt: Date;
  readonly priceUsd: number | null;
  readonly marketCapUsd: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly holders: number | null;
  readonly finalScore: number | null;
  readonly dataCompleteness: number;
  readonly scoreEngineVersion: string | null;
}

export interface PitSecurity {
  readonly tokenId: string;
  readonly observedAt: Date;
  readonly mintAuthorityActive: boolean | null;
  readonly freezeAuthorityActive: boolean | null;
  readonly lpBurnedOrLocked: boolean | null;
  readonly top10HolderSharePct: number | null;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  readonly securityScore: number | null;
}

export interface PitReader {
  /** Nur zur Diagnose — die Abfragelogik ist in beiden Modi identisch. */
  readonly mode: "live" | "backtest";

  /** Juengster Snapshot mit `observedAt <= asOf`. */
  snapshotAt(tokenId: string, asOf: Date): Promise<PitSnapshot | null>;

  /** Alle Snapshots im halboffenen Intervall (from, asOf], aufsteigend. */
  snapshotsBetween(tokenId: string, from: Date, asOf: Date): Promise<PitSnapshot[]>;

  /** Juengster Sicherheitsbefund mit `observedAt <= asOf`. */
  securityAt(tokenId: string, asOf: Date): Promise<PitSecurity | null>;

  /**
   * Wallets, die zum Zeitpunkt `asOf` als Smart Money qualifiziert WAREN.
   *
   * Beruecksichtigt `qualifiedAt <= asOf` und eine spaetere Disqualifikation.
   * Wer stattdessen die heutige Liste verwendet, misst nur, dass rueckblickend
   * bekannte Gewinner gewonnen haben.
   */
  smartMoneyQualifiedAt(asOf: Date): Promise<string[]>;
}
