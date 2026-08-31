import type { Currency, OpportunityState, SizingMode, TradingStream } from "@sae/core";

import {
  observationCategoryOf,
  performanceCategoryOf,
  statisticsKeyOf,
  type ObservationCategory,
  type PerformanceCategory,
  type StatisticsKey,
} from "./categories";
import { wilsonInterval } from "./factor-analysis";
import {
  computeTradeStatistics,
  MIN_SAMPLE_FOR_VERDICT,
  type ClosedTrade,
  type TradeStatistics,
} from "./trade-statistics";

/**
 * Kategorie-getrennte Auswertung.
 *
 * Dieses Modul ist die technische Fassung der vier Invarianten:
 *
 *   MISSED OPPORTUNITY ≠ LOSS
 *   USER REJECTED      ≠ LOSS
 *   PAPER TRADE        ≠ LIVE TRADE
 *   und: keine Kennzahl ueber verschiedene Sizing-Verfahren hinweg.
 *
 * Die Trennung ist bewusst NICHT als Filter gebaut. Ein Filter ist eine
 * Vereinbarung, an die sich jede kuenftige Abfrage halten muss — und irgendeine
 * haelt sich nicht daran. Stattdessen:
 *
 * 1. Beobachtungen kommen hier ohne Kapitalgroesse an. `ObservationRow` hat
 *    keine `Money`-Spalte, also gibt es nichts, was sich mit einem Ergebnis
 *    verrechnen liesse. Verpasst und abgelehnt koennen strukturell nicht zu
 *    einem Verlust werden.
 * 2. `PaperTradeRecord.stream` schliesst LIVE typseitig aus, und der Trade
 *    selbst ist auf `mode: "paper"` verengt. Ein Live-Trade kommt in dieser
 *    Auswertung nicht an.
 * 3. `computeCategoryStatistics` wirft bei gemischten Schluesseln, statt still
 *    zu mitteln. Es gibt in diesem Modul KEINE Funktion, die ueber Kategorien
 *    oder Sizing-Verfahren hinweg summiert — das ist Absicht, keine Luecke.
 */

/** Stroeme mit Performance-Aussage. LIVE ist hier nicht darstellbar. */
export type PaperStream = Exclude<TradingStream, "LIVE">;

/** Ein abgeschlossener Trade, der nachweislich simuliert war. */
export type PaperClosedTrade = ClosedTrade & { readonly mode: "paper" };

export interface PaperTradeRecord {
  readonly stream: PaperStream;
  readonly sizingMode: SizingMode;
  readonly trade: PaperClosedTrade;
}

/**
 * Eine Gelegenheit, die keine Position erzeugt hat.
 *
 * Absichtlich ohne jede Kapitalspalte: nur Zustand und hypothetische Anteile.
 * Wer hier einen Betrag ergaenzen will, muss erst erklaeren, gegen welche der
 * beiden Invarianten er verstoesst.
 */
export interface ObservationRow {
  readonly opportunityId: string;
  readonly state: OpportunityState;
  /** Hoechster Punkt nach der Entscheidung, als Anteil. `null` = unbeobachtet. */
  readonly hypotheticalMfe: number | null;
  /** Tiefster Punkt nach der Entscheidung, als Anteil. */
  readonly hypotheticalMae: number | null;
}

/**
 * Ab welchem hypothetischen Hoch eine abgelaufene Gelegenheit als "verpasst"
 * gilt.
 *
 * Das ist eine BERICHTSKONVENTION, keine gemessene Groesse. Begruendung fuer die
 * Hoehe: ein Round Trip kostet bei 100 EUR Einsatz nach dem Kostenmodell
 * groessenordnungsmaessig 1,5 bis 3 Prozent; alles knapp darueber waere kein
 * verpasster Gewinn, sondern Rauschen. 25 Prozent liegt deutlich darueber,
 * ist aber nicht aus Daten abgeleitet — sobald die Verteilung der
 * `hypotheticalMfe` aus echten Beobachtungen vorliegt, gehoert dieser Wert
 * ueberprueft und ersetzt.
 */
export const DEFAULT_MISSED_MFE_THRESHOLD = 0.25;

export interface CategoryStatistics {
  readonly key: StatisticsKey;
  readonly statistics: TradeStatistics;
  /** 95-%-Intervall auf die Trefferquote, `null` bei leerer Stichprobe. */
  readonly winRateInterval: { readonly lower: number; readonly upper: number } | null;
  readonly verdict: "TOO_LITTLE_DATA" | "MEASURED";
}

export interface ObservationSummary {
  readonly category: ObservationCategory;
  readonly count: number;
  /** Median der hypothetischen Hochs. Anteil, kein Betrag. */
  readonly medianHypotheticalMfe: number | null;
  readonly medianHypotheticalMae: number | null;
}

/**
 * Vollstaendige Auswertung eines Zeitraums.
 *
 * Die Felder sind bewusst nebeneinander und nicht verrechnet. `producedPosition`
 * ist die Brueckenzahl: Beobachtungen und Positionen ergeben zusammen wieder
 * alle Gelegenheiten, ohne dass irgendwo etwas verschwindet.
 */
export interface CategoryReport {
  readonly currency: Currency;
  readonly performance: readonly CategoryStatistics[];
  readonly observations: readonly ObservationSummary[];
  /** Gelegenheiten, die zu einer Position gefuehrt haben. */
  readonly producedPosition: number;
  /** Noch offen: angeboten, gesehen oder bestaetigt, aber ohne Endzustand. */
  readonly stillOpen: number;
  readonly missedThreshold: number;
}

export function keyOf(record: PaperTradeRecord): StatisticsKey {
  const category = performanceCategoryOf(record.stream);
  if (category === null) {
    // Unerreichbar ueber den Typ; bleibt als Schutz gegen ungetypte DB-Zeilen.
    throw new TypeError(`Strom ${record.stream} hat keine Performance-Kategorie`);
  }
  return { category, sizingMode: record.sizingMode };
}

/**
 * Kennzahlen fuer GENAU einen Schluessel.
 *
 * Wirft bei gemischten Eingaben. Der Fehler ist der Punkt: eine Kennzahl ueber
 * zwei Kategorien oder zwei Sizing-Verfahren ist nicht ungenau, sie ist
 * bedeutungslos — und still gemittelt sieht sie aus wie eine Aussage.
 */
export function computeCategoryStatistics(
  records: readonly PaperTradeRecord[],
  currency: Currency,
  expected?: StatisticsKey,
): CategoryStatistics {
  if (records.length === 0) {
    if (expected === undefined) {
      throw new TypeError("Leere Stichprobe ohne angegebenen Schluessel ist nicht auswertbar");
    }
    return {
      key: expected,
      statistics: computeTradeStatistics([], currency),
      winRateInterval: null,
      verdict: "TOO_LITTLE_DATA",
    };
  }

  const first = records[0]!;
  const key = expected ?? keyOf(first);
  const wanted = statisticsKeyOf(key);
  for (const record of records) {
    const actual = statisticsKeyOf(keyOf(record));
    if (actual !== wanted) {
      throw new TypeError(
        `Vermischte Auswertung: ${record.trade.tradeId} gehoert zu ${actual}, nicht zu ${wanted}`,
      );
    }
    if (record.trade.mode !== "paper") {
      throw new TypeError(`Trade ${record.trade.tradeId} ist kein Paper-Trade`);
    }
  }

  const statistics = computeTradeStatistics(
    records.map((r) => r.trade),
    currency,
  );
  return {
    key,
    statistics,
    winRateInterval: wilsonInterval(statistics.winningTrades, statistics.totalTrades),
    verdict: statistics.totalTrades >= MIN_SAMPLE_FOR_VERDICT ? "MEASURED" : "TOO_LITTLE_DATA",
  };
}

/**
 * Zerlegt eine gemischte Menge in die Schluessel, ueber die ausgewertet werden
 * darf. Das Ergebnis ist eine Liste — bewusst keine Gesamtzahl daneben.
 */
export function groupPerformance(
  records: readonly PaperTradeRecord[],
  currency: Currency,
): readonly CategoryStatistics[] {
  const groups = new Map<string, { key: StatisticsKey; rows: PaperTradeRecord[] }>();
  for (const record of records) {
    const key = keyOf(record);
    const id = statisticsKeyOf(key);
    const existing = groups.get(id);
    if (existing === undefined) {
      groups.set(id, { key, rows: [record] });
    } else {
      existing.rows.push(record);
    }
  }

  return [...groups.values()]
    .map((g) => computeCategoryStatistics(g.rows, currency, g.key))
    .sort((a, b) => statisticsKeyOf(a.key).localeCompare(statisticsKeyOf(b.key)));
}

export interface ObservationBreakdown {
  readonly summaries: readonly ObservationSummary[];
  readonly producedPosition: number;
  readonly stillOpen: number;
}

export function summarizeObservations(
  rows: readonly ObservationRow[],
  missedThreshold: number = DEFAULT_MISSED_MFE_THRESHOLD,
): ObservationBreakdown {
  const buckets = new Map<ObservationCategory, ObservationRow[]>();
  let producedPosition = 0;
  let stillOpen = 0;

  for (const row of rows) {
    const category = observationCategoryOf({
      state: row.state,
      hypotheticalMfe: row.hypotheticalMfe,
      missedThreshold,
    });
    if (category === null) {
      // Zwei verschiedene Faelle, die nicht zusammengezaehlt werden duerfen:
      // eine eroeffnete Position ist ein Ergebnis, eine noch offene Gelegenheit
      // ist noch gar nichts. Eine gemeinsame Zahl waere in beide Richtungen
      // falsch — sie liesse offene Faelle wie Erfolge aussehen.
      if (row.state === "POSITION_OPENED") producedPosition += 1;
      else stillOpen += 1;
      continue;
    }
    const bucket = buckets.get(category);
    if (bucket === undefined) buckets.set(category, [row]);
    else bucket.push(row);
  }

  const summaries = [...buckets.entries()]
    .map(([category, entries]) => ({
      category,
      count: entries.length,
      medianHypotheticalMfe: median(entries.map((e) => e.hypotheticalMfe)),
      medianHypotheticalMae: median(entries.map((e) => e.hypotheticalMae)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return { summaries, producedPosition, stillOpen };
}

export function buildCategoryReport(input: {
  readonly records: readonly PaperTradeRecord[];
  readonly observations: readonly ObservationRow[];
  readonly currency: Currency;
  readonly missedThreshold?: number;
}): CategoryReport {
  const missedThreshold = input.missedThreshold ?? DEFAULT_MISSED_MFE_THRESHOLD;
  const { summaries, producedPosition, stillOpen } = summarizeObservations(
    input.observations,
    missedThreshold,
  );
  return {
    currency: input.currency,
    performance: groupPerformance(input.records, input.currency),
    observations: summaries,
    producedPosition,
    stillOpen,
    missedThreshold,
  };
}

/**
 * Welche Kategorien in einer Performance-Aussage vorkommen duerfen, als Klartext
 * fuer die Oberflaeche. Zweck ist Beschriftung, nicht Rechnen.
 */
export function performanceLabel(category: PerformanceCategory): string {
  return category === "AUTO_PAPER_PERFORMANCE"
    ? "Auto Paper (simuliert)"
    : "Manual Paper, bestaetigt (simuliert)";
}

function median(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (present.length === 0) return null;
  const mid = Math.floor(present.length / 2);
  if (present.length % 2 === 1) return present[mid]!;
  return (present[mid - 1]! + present[mid]!) / 2;
}
