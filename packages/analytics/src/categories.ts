import type { OpportunityState, SizingMode, TradingStream } from "@sae/core";

/**
 * Leistungskategorien.
 *
 * Spec §136 verlangt mindestens vier, strikt getrennt. Sie duerfen niemals
 * unkontrolliert zusammengefuehrt werden.
 *
 * Die Trennung ist hier NICHT als Filter umgesetzt, sondern folgt aus der
 * Datenherkunft: die beiden Performance-Kategorien lesen aus `paper_positions`,
 * die drei Beobachtungskategorien aus `opportunities` und
 * `opportunity_outcomes` — und letztere haben keine Kapitalspalte. Ein
 * versehentliches Zusammenrechnen scheitert damit am Typ, nicht an der Sorgfalt.
 */
export type PerformanceCategory =
  /** Was ein autonomer Trader getan haette. Echte simulierte Positionen. */
  | "AUTO_PAPER_PERFORMANCE"
  /** Was ein verfuegbarer Mensch nach rechtzeitiger Bestaetigung getan haette. */
  | "CONFIRMED_MANUAL_PAPER_PERFORMANCE";

export type ObservationCategory =
  /** Gelegenheit war da, der Nutzer konnte nicht reagieren, es haette sich gelohnt. */
  | "MISSED_MANUAL_OPPORTUNITIES"
  /** Nutzer war verfuegbar und hat bewusst abgelehnt. */
  | "USER_REJECTED_OPPORTUNITIES"
  /** Antwortfenster abgelaufen (ob es sich gelohnt haette, sagt MISSED). */
  | "EXPIRED"
  /** Nutzer war rechtzeitig da, aber die Revalidierung scheiterte. */
  | "INVALIDATED"
  /** System hat die Gelegenheit zurueckgezogen. */
  | "CANCELLED";

export type Category = PerformanceCategory | ObservationCategory;

/**
 * Nur diese beiden Kategorien duerfen in eine Performance-Aussage einfliessen.
 *
 * Die technische Fassung von „MISSED ≠ LOSS" und „USER_REJECTED ≠ LOSS".
 */
export const PERFORMANCE_CATEGORIES: readonly PerformanceCategory[] = [
  "AUTO_PAPER_PERFORMANCE",
  "CONFIRMED_MANUAL_PAPER_PERFORMANCE",
];

export function isPerformanceCategory(c: Category): c is PerformanceCategory {
  return (PERFORMANCE_CATEGORIES as readonly Category[]).includes(c);
}

/**
 * Kategorie einer Gelegenheit, die KEINE Position erzeugt hat.
 *
 * `null` bedeutet: sie hat eine Position erzeugt und gehoert damit in eine
 * Performance-Kategorie, nicht hierher.
 */
export function observationCategoryOf(input: {
  readonly state: OpportunityState;
  readonly hypotheticalMfe: number | null;
  readonly missedThreshold: number;
}): ObservationCategory | null {
  switch (input.state) {
    case "REJECTED":
      return "USER_REJECTED_OPPORTUNITIES";
    case "INVALIDATED":
      return "INVALIDATED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      // MISSED ist eine Klassifikation von EXPIRED, kein eigener Zustand: ob
      // sich eine Reaktion gelohnt haette, laesst sich erst nach dem Verlauf
      // sagen. Ohne Verlaufsdaten bleibt es schlicht EXPIRED.
      if (input.hypotheticalMfe !== null && input.hypotheticalMfe >= input.missedThreshold) {
        return "MISSED_MANUAL_OPPORTUNITIES";
      }
      return "EXPIRED";
    default:
      return null;
  }
}

/**
 * Kategorie einer Position.
 *
 * Der Live-Strom hat hier bewusst keine Kategorie: `PAPER ≠ LIVE` wird nicht
 * ueber eine Spalte getrennt, sondern ueber getrennte Tabellen. Eine
 * Live-Position kommt in dieser Auswertung gar nicht erst an.
 */
export function performanceCategoryOf(stream: TradingStream): PerformanceCategory | null {
  if (stream === "AUTO_PAPER") return "AUTO_PAPER_PERFORMANCE";
  if (stream === "MANUAL_PAPER") return "CONFIRMED_MANUAL_PAPER_PERFORMANCE";
  return null;
}

/**
 * Achse, ueber die NIEMALS aggregiert werden darf.
 *
 * Kategorie und Sizing-Verfahren zusammen. Zwei Positionen sind nur dann
 * vergleichbar, wenn beide uebereinstimmen — sonst mischt man verschiedene
 * Renditeverteilungen in eine Kennzahl.
 */
export interface StatisticsKey {
  readonly category: PerformanceCategory;
  readonly sizingMode: SizingMode;
}

export const statisticsKeyOf = (k: StatisticsKey): string =>
  `${k.category}:${k.sizingMode}`;
