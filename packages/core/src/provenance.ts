/**
 * Herkunft eines Datensatzes.
 *
 * Der Zweck ist eine einzige Frage, die sich spaeter nicht mehr rekonstruieren
 * laesst, wenn man sie nicht von Anfang an mitschreibt: **woher kam die Zahl,
 * auf der diese Entscheidung beruht?**
 *
 * Drei Herkuenfte, und die Unterscheidung ist keine Formalie:
 *
 *   LIVE          Ein erreichbarer Anbieter hat geantwortet. Nur diese Daten
 *                 duerfen in Strategie-Kennzahlen, Forschung und Promotion.
 *   TEST_FIXTURE  Ein ausdruecklich als Test gekennzeichneter Eingabewert.
 *                 Beweist, dass die Pipeline technisch laeuft — und sonst
 *                 nichts. Er ist KEIN Anbieter, er taucht in keiner Kette auf,
 *                 und er darf niemals in eine Auswertung geraten.
 *   BACKTEST      Historische Daten aus der eigenen Datenbank ueber den
 *                 PitReader. Eigene Kategorie, weil ein Backtest-Ergebnis etwas
 *                 anderes behauptet als ein Paper-Ergebnis.
 *
 * Warum das ein eigener Typ ist und kein boolean: ein `isTest`-Flag beantwortet
 * „ist das echt?", aber nicht „wie echt, und woher". Bei der ersten Frage nach
 * der Datenqualitaet einer Auswertung braucht man die zweite Antwort.
 */

export const SOURCE_TYPES = ["LIVE", "TEST_FIXTURE", "BACKTEST"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Herkunfts- und Qualitaetsangaben, die jede Gelegenheit und jede Paper-Position
 * mitfuehrt.
 *
 * Die Zeitstempel sind bewusst drei und nicht einer:
 *
 *   dataTimestamp     Wann galt die Beobachtung? (der `asOf` des Snapshots)
 *   sourceTimestamp   Wann hat die Quelle geantwortet bzw. wurde der Fixture
 *                     eingespeist? Die Differenz zum vorigen ist die Frische.
 *   decisionTimestamp Wann wurde entschieden? Die Differenz zum vorigen ist die
 *                     Verarbeitungszeit.
 *
 * Zusammengelegt waere nicht mehr unterscheidbar, ob eine Entscheidung auf
 * alten Daten beruhte oder ob die Verarbeitung lange gedauert hat — zwei
 * verschiedene Probleme mit zwei verschiedenen Ursachen.
 */
export interface DataProvenance {
  readonly sourceType: SourceType;
  /**
   * Anbieterkennung, oder das Fixture-Etikett bei `TEST_FIXTURE`.
   * Nie `null`: ein Datensatz ohne benennbare Herkunft duerfte nicht entstehen.
   */
  readonly sourceProvider: string;
  /** Qualitaetsstufe der Kette. `null` bei Herkunft ohne Kette (Fixture). */
  readonly sourceTier: "PRIMARY" | "SECONDARY" | "FALLBACK" | null;
  readonly sourceTimestamp: Date;
  readonly dataTimestamp: Date;
  readonly decisionTimestamp: Date;
  /** Anteil vorhandener Eingabefelder, 0..1. */
  readonly dataQuality: number;
}

/** Etikett fuer Fixture-Quellen. Beginnt sichtbar mit dem Wort. */
export const TEST_FIXTURE_PROVIDER_PREFIX = "TEST_FIXTURE:";

export function isTestFixture(sourceType: SourceType): boolean {
  return sourceType === "TEST_FIXTURE";
}

/**
 * Darf dieser Datensatz in Produktions-Kennzahlen?
 *
 * Die eine Stelle, an der diese Frage beantwortet wird. Jede Auswertung, jedes
 * Dashboard-Panel und jedes Promotionsgate ruft sie — statt jeweils selbst ein
 * `!== "TEST_FIXTURE"` hinzuschreiben, das man an einer Stelle vergessen kann.
 *
 * BACKTEST zaehlt hier ebenfalls nicht: ein Backtest-Ergebnis gehoert in die
 * Backtest-Auswertung, nicht in die Paper-Performance.
 */
export function countsAsProductionPerformance(sourceType: SourceType): boolean {
  return sourceType === "LIVE";
}

/**
 * Prueft, dass eine Herkunft in sich stimmig ist.
 *
 * Wirft statt zu korrigieren. Eine stillschweigend reparierte Herkunft ist
 * schlimmer als eine falsche: sie sieht danach richtig aus.
 */
export function assertProvenanceConsistent(p: DataProvenance): void {
  if (p.sourceProvider.length === 0) {
    throw new TypeError("Herkunft ohne Anbieterkennung");
  }
  if (isTestFixture(p.sourceType) && !p.sourceProvider.startsWith(TEST_FIXTURE_PROVIDER_PREFIX)) {
    throw new TypeError(
      `TEST_FIXTURE muss als solches erkennbar sein: "${p.sourceProvider}" beginnt nicht mit ${TEST_FIXTURE_PROVIDER_PREFIX}`,
    );
  }
  if (!isTestFixture(p.sourceType) && p.sourceProvider.startsWith(TEST_FIXTURE_PROVIDER_PREFIX)) {
    throw new TypeError(
      `Nur TEST_FIXTURE darf das Fixture-Etikett tragen, nicht ${p.sourceType}`,
    );
  }
  if (p.dataQuality < 0 || p.dataQuality > 1) {
    throw new RangeError(`dataQuality liegt ausserhalb 0..1: ${p.dataQuality}`);
  }
  // Eine Entscheidung vor ihren eigenen Daten waere Look-Ahead.
  if (p.decisionTimestamp.getTime() < p.dataTimestamp.getTime()) {
    throw new RangeError("decisionTimestamp liegt vor dataTimestamp");
  }
}

/**
 * Darf ein Feature eine Handelsentscheidung tragen?
 *
 * Die Frage entsteht aus einem sehr konkreten Problem: manche Anbieter liefern
 * einen Wert ohne zu sagen, WANN er galt. Ein solcher Wert ist nicht wertlos —
 * fuer die Forschung ist er brauchbar — aber er laesst sich nicht in die
 * Zeitachse einordnen. Und ohne Zeitpunkt laesst sich nicht pruefen, ob er zum
 * Entscheidungszeitpunkt schon bekannt war.
 *
 * Deshalb zwei Stufen, und die schwaechere ist der Standard:
 *
 *   DECISION_SAFE   Der Anbieter hat einen Beobachtungszeitpunkt geliefert.
 *                   Das Feature darf in eine Entscheidung.
 *   RESEARCH_ONLY   Kein Beobachtungszeitpunkt, oder der Datensatz ist zu alt
 *                   fuer seine Feldklasse. Das Feature wird gespeichert und
 *                   ausgewertet, aber es traegt keinen Einstieg.
 *
 * Der Grund fuer die Trennung ist nicht Vorsicht, sondern eine Fehlerart: ein
 * scheinbar aktueller Wert ohne Zeitstempel sieht spaeter in der Historie
 * genauso aus wie ein verankerter. Wer das nicht beim Schreiben unterscheidet,
 * kann es hinterher nicht mehr rekonstruieren.
 */
export const DECISION_SAFETIES = ["DECISION_SAFE", "RESEARCH_ONLY"] as const;
export type DecisionSafety = (typeof DECISION_SAFETIES)[number];

/**
 * Leitet die Stufe aus der Herkunft ab.
 *
 * Bewusst eine Funktion und kein Feld, das der Aufrufer setzt: die Regel soll
 * an einer Stelle stehen, nicht an jeder Schreibstelle neu entschieden werden.
 */
export function decisionSafetyOf(input: {
  /** `null`, wenn der Anbieter keinen Beobachtungszeitpunkt liefert. */
  readonly observedAt: Date | null;
  readonly sourceType: SourceType;
}): DecisionSafety {
  // Ohne Zeitpunkt keine Entscheidung. Einen zu erfinden waere genau der
  // Fehler, den diese Unterscheidung verhindern soll.
  if (input.observedAt === null) return "RESEARCH_ONLY";
  // Ein Fixture traegt nie eine Entscheidung ueber echtes Geld.
  if (isTestFixture(input.sourceType)) return "RESEARCH_ONLY";
  return "DECISION_SAFE";
}
