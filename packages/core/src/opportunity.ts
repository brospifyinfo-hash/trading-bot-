import type { DecisionId, StrategyVersionId, TokenId } from "./ids";
import type { Money } from "./money";
import type { Score, SignalKind } from "./decision";
import type { OpportunityState } from "./opportunity-state-machine";
import type { SizingMode, TradingStream } from "./streams";

/**
 * Eine Handelsgelegenheit.
 *
 * Sie ist eine BEOBACHTUNG, kein Kapital. Das ist die Trennung, auf der die
 * gesamte Kategorientrennung ruht: eine verpasste oder abgelehnte Gelegenheit
 * kann nicht in die Performance geraten, weil sie keine Position erzeugt — nicht,
 * weil irgendwo ein Filter sie ausschliesst.
 *
 * Sie entsteht fuer JEDEN bewerteten Token, nicht nur fuer die mit ENTER.
 * Spec §93 verlangt, dass Champion und Challenger dieselben Gelegenheiten sehen;
 * daraus folgt, dass die Erzeugung nicht von der Entscheidung abhaengen darf.
 * Nebeneffekt: die abgelehnten sind die Kontrollgruppe fuer §41 und §42.
 */
export interface Opportunity {
  readonly opportunityId: string;
  readonly tokenId: TokenId;
  readonly stream: TradingStream;
  readonly state: OpportunityState;

  /** Was die Entscheidungsmaschine zu diesem Zeitpunkt geurteilt hat. */
  readonly decisionKind: SignalKind;
  readonly decisionId: DecisionId;
  readonly finalScore: Score | null;
  readonly strategyVersionId: StrategyVersionId;

  /** Verweis auf den eingefrorenen Feature-Vektor. Pflicht. */
  readonly featureSnapshotId: string;

  /** Zeitpunkt der Entscheidung. Zugleich der `asOf` des Snapshots. */
  readonly decidedAt: Date;
  /** Nur im Manual-Strom gesetzt: bis wann eine Reaktion zaehlt. */
  readonly respondBy: Date | null;
  readonly closedAt: Date | null;
}

/**
 * Was mit dem Token NACH der Gelegenheit passiert ist.
 *
 * Der wichtigste Punkt an dieser Struktur ist, was sie NICHT hat: keine
 * Verbindung zu Kapital, keine Positionsgroesse, kein realisiertes Ergebnis in
 * Portfoliowaehrung. Nur hypothetische Renditen.
 *
 * Damit ist es strukturell unmoeglich, sie in eine Performance-Abfrage zu ziehen —
 * es gibt schlicht keine Spalte, die sich mit einem realisierten Ergebnis
 * verrechnen liesse. Genau das erfuellt §42, §66 und §78.
 */
export interface OpportunityOutcome {
  readonly opportunityId: string;
  /** Referenzpreis zum Entscheidungszeitpunkt. */
  readonly referencePriceUsd: number;
  /** Hypothetische Rendite je Horizont, als Anteil. `null` = noch nicht erreicht. */
  readonly return5m: number | null;
  readonly return15m: number | null;
  readonly return30m: number | null;
  readonly return1h: number | null;
  readonly return4h: number | null;
  /** Hoechster und tiefster Punkt nach der Entscheidung, als Anteil. */
  readonly hypotheticalMfe: number | null;
  readonly hypotheticalMae: number | null;
  readonly observedUntil: Date;
}

/** Eine Nutzerreaktion auf eine Manual-Gelegenheit. */
export type ManualResponseKind = "SEEN" | "USER_CONFIRMED" | "REJECTED";

export interface ManualResponse {
  readonly opportunityId: string;
  readonly kind: ManualResponseKind;
  readonly at: Date;
  /**
   * Zeit zwischen Alert und dieser Reaktion.
   *
   * Wird je Gelegenheit einzeln gefuehrt, nicht als Mittelwert. Spec §80 will
   * realistische menschliche Latenz — ein Median glaettet genau die Faelle weg,
   * in denen die Verzoegerung wehtat.
   */
  readonly responseMs: number;
}

/**
 * Eine simulierte Position.
 *
 * Entsteht ausschliesslich aus einer Auto-ENTER-Entscheidung oder einer
 * bestaetigten Manual-Gelegenheit. `sizingMode` ist Pflicht: die beiden
 * Verfahren erzeugen verschiedene Verteilungen und duerfen nie in derselben
 * Kennzahl landen.
 */
export interface PaperPositionRef {
  readonly positionId: string;
  readonly opportunityId: string;
  readonly stream: TradingStream;
  readonly sizingMode: SizingMode;
  readonly entryNotional: Money;
  readonly openedAt: Date;
}
