import { describe, expect, it } from "vitest";

import {
  DEFAULT_MISSED_MFE_THRESHOLD,
  buildCategoryReport,
  computeCategoryStatistics,
  groupPerformance,
  summarizeObservations,
  type ObservationRow,
  type PaperTradeRecord,
} from "../category-statistics";
import { performanceCategoryOf, statisticsKeyOf } from "../categories";
import { paperRecord } from "./fixtures";

/**
 * Die vier Invarianten aus den Ground Rules, je als eigener Test.
 *
 * Sie sind nicht verhandelbar, deshalb stehen sie hier einzeln und namentlich
 * und nicht als Unterpunkte einer allgemeinen Statistik-Suite. Wer eine davon
 * bricht, soll den Namen der Regel im Testprotokoll lesen.
 */

let rowCounter = 0;
function observation(
  state: ObservationRow["state"],
  mfe: number | null,
  mae: number | null = null,
): ObservationRow {
  rowCounter += 1;
  return {
    opportunityId: `opp-${rowCounter}`,
    state,
    hypotheticalMfe: mfe,
    hypotheticalMae: mae,
  };
}

const baseRecords: readonly PaperTradeRecord[] = [
  paperRecord(20, "AUTO_PAPER", "FIXED_100"),
  paperRecord(-10, "AUTO_PAPER", "FIXED_100"),
  paperRecord(35, "MANUAL_PAPER", "FIXED_100"),
];

describe("MISSED_IS_NOT_LOSS — MISSED OPPORTUNITY ≠ LOSS", () => {
  it("ordnet eine abgelaufene Gelegenheit mit hohem Hoch als MISSED ein, nicht als Trade", () => {
    const { summaries, producedPosition, stillOpen } = summarizeObservations([
      observation("EXPIRED", 1.8),
    ]);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.category).toBe("MISSED_MANUAL_OPPORTUNITIES");
    expect(producedPosition).toBe(0);
    expect(stillOpen).toBe(0);
  });

  it("laesst die Performance unveraendert, egal wie viele Gelegenheiten verpasst wurden", () => {
    const without = buildCategoryReport({
      records: baseRecords,
      observations: [],
      currency: "EUR",
    });
    const withMissed = buildCategoryReport({
      records: baseRecords,
      observations: [
        observation("EXPIRED", 3.4),
        observation("EXPIRED", 12.0),
        observation("EXPIRED", 0.9),
      ],
      currency: "EUR",
    });

    // Drei verpasste Verzehnfacher aendern an dem, was das System tatsaechlich
    // getan hat, exakt nichts. Das ist der ganze Punkt der Regel.
    expect(withMissed.performance).toEqual(without.performance);
    expect(withMissed.observations[0]!.count).toBe(3);
  });

  it("gibt Beobachtungen ueberhaupt keinen Kapitalbezug", () => {
    const { summaries } = summarizeObservations([observation("EXPIRED", 2.0, -0.4)]);
    for (const summary of summaries) {
      for (const value of Object.values(summary)) {
        // Ein Money-Wert waere ein Objekt. Gibt es hier eines, existiert eine
        // Spalte, die sich mit einem realisierten Ergebnis verrechnen liesse.
        expect(typeof value === "object" && value !== null).toBe(false);
      }
    }
  });

  it("kennt keinen Weg, eine Beobachtung in die Performance zu geben", () => {
    const row = observation("EXPIRED", 2.0);
    // @ts-expect-error Eine Beobachtung ist kein PaperTradeRecord — und soll es nie werden.
    expect(() => computeCategoryStatistics([row], "EUR")).toThrow();
  });

  it("nennt eine abgelaufene Gelegenheit ohne Verlaufsdaten nicht verpasst", () => {
    const { summaries } = summarizeObservations([observation("EXPIRED", null)]);
    expect(summaries[0]!.category).toBe("EXPIRED");
  });

  it("nennt eine abgelaufene Gelegenheit unter der Schwelle nicht verpasst", () => {
    const { summaries } = summarizeObservations([
      observation("EXPIRED", DEFAULT_MISSED_MFE_THRESHOLD - 0.01),
    ]);
    expect(summaries[0]!.category).toBe("EXPIRED");
  });
});

describe("USER_REJECTED_IS_NOT_LOSS — USER REJECTED ≠ LOSS", () => {
  it("fuehrt eine bewusste Ablehnung als eigene Kategorie, nicht als Trade", () => {
    const { summaries, producedPosition } = summarizeObservations([
      observation("REJECTED", 0.1, -0.92),
    ]);

    expect(summaries[0]!.category).toBe("USER_REJECTED_OPPORTUNITIES");
    // Auch mit katastrophalem hypothetischen Tief: kein ausgefuehrter Trade,
    // also kein Verlust.
    expect(producedPosition).toBe(0);
  });

  it("aendert die bestaetigte Manual-Performance nicht", () => {
    const withRejections = buildCategoryReport({
      records: baseRecords,
      observations: [observation("REJECTED", 5.0, -0.8), observation("REJECTED", 0.0, -0.99)],
      currency: "EUR",
    });
    const manual = withRejections.performance.find(
      (p) => p.key.category === "CONFIRMED_MANUAL_PAPER_PERFORMANCE",
    );

    expect(manual?.statistics.totalTrades).toBe(1);
    expect(manual?.statistics.losingTrades).toBe(0);
  });

  it("zaehlt eine Ablehnung auch dann nicht als verpasst, wenn es gelaufen waere", () => {
    // Der Unterschied ist inhaltlich: bei MISSED war der Nutzer nicht da, bei
    // REJECTED hat er entschieden. Beides in einen Topf zu werfen wuerde die
    // Auswertung der Entscheidungsqualitaet unmoeglich machen.
    const { summaries } = summarizeObservations([observation("REJECTED", 9.9)]);
    expect(summaries[0]!.category).toBe("USER_REJECTED_OPPORTUNITIES");
  });
});

describe("PAPER_IS_NOT_LIVE — PAPER TRADE ≠ LIVE TRADE", () => {
  it("hat fuer LIVE keine Performance-Kategorie", () => {
    expect(performanceCategoryOf("LIVE")).toBeNull();
    expect(performanceCategoryOf("AUTO_PAPER")).toBe("AUTO_PAPER_PERFORMANCE");
    expect(performanceCategoryOf("MANUAL_PAPER")).toBe("CONFIRMED_MANUAL_PAPER_PERFORMANCE");
  });

  it("laesst einen Live-Strom in dieser Auswertung nicht zu", () => {
    const record: PaperTradeRecord = {
      // @ts-expect-error LIVE ist in einer Paper-Auswertung nicht darstellbar.
      stream: "LIVE",
      sizingMode: "FIXED_100",
      trade: paperRecord(10, "AUTO_PAPER", "FIXED_100").trade,
    };
    expect(() => computeCategoryStatistics([record], "EUR")).toThrow(/Performance-Kategorie/);
  });

  it("weist einen Live-Trade auch dann ab, wenn er ungetypt hereinkommt", () => {
    // Der Fall aus der Praxis: eine Zeile aus der Datenbank, an der Typen nicht
    // mehr helfen. Deshalb zusaetzlich zur Typschranke eine Laufzeitschranke.
    const fromDatabase = {
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      trade: { ...paperRecord(10, "AUTO_PAPER", "FIXED_100").trade, mode: "live" },
    } as unknown as PaperTradeRecord;

    expect(() => computeCategoryStatistics([fromDatabase], "EUR")).toThrow(/kein Paper-Trade/);
  });
});

describe("Invariante: keine Kennzahl ueber verschiedene Sizing-Verfahren", () => {
  it("verweigert eine gemeinsame Kennzahl fuer FIXED_100 und RISK_BASED", () => {
    const mixed = [
      paperRecord(20, "AUTO_PAPER", "FIXED_100"),
      paperRecord(20, "AUTO_PAPER", "RISK_BASED"),
    ];
    expect(() => computeCategoryStatistics(mixed, "EUR")).toThrow(/Vermischte Auswertung/);
  });

  it("verweigert eine gemeinsame Kennzahl fuer Auto und Manual", () => {
    const mixed = [
      paperRecord(20, "AUTO_PAPER", "FIXED_100"),
      paperRecord(20, "MANUAL_PAPER", "FIXED_100"),
    ];
    expect(() => computeCategoryStatistics(mixed, "EUR")).toThrow(/Vermischte Auswertung/);
  });

  it("zerlegt eine gemischte Menge in getrennte Schluessel", () => {
    const groups = groupPerformance(
      [
        paperRecord(20, "AUTO_PAPER", "FIXED_100"),
        paperRecord(-40, "AUTO_PAPER", "RISK_BASED"),
        paperRecord(15, "MANUAL_PAPER", "FIXED_100"),
      ],
      "EUR",
    );

    expect(groups.map((g) => statisticsKeyOf(g.key))).toEqual([
      "AUTO_PAPER_PERFORMANCE:FIXED_100",
      "AUTO_PAPER_PERFORMANCE:RISK_BASED",
      "CONFIRMED_MANUAL_PAPER_PERFORMANCE:FIXED_100",
    ]);
    for (const group of groups) {
      expect(group.statistics.totalTrades).toBe(1);
      // Eine Aussage traegt keine dieser Gruppen — und sagt das auch.
      expect(group.verdict).toBe("TOO_LITTLE_DATA");
    }
  });

  it("bietet nirgends eine Gesamtzahl ueber die Schluessel hinweg an", () => {
    const report = buildCategoryReport({
      records: baseRecords,
      observations: [observation("EXPIRED", 1.0)],
      currency: "EUR",
    });

    // Die Form ist hier festgenagelt: ein spaeter ergaenztes Summenfeld — egal
    // wie sinnvoll es im Moment des Einbaus aussieht — laesst diesen Test
    // fehlschlagen und zwingt zu einer Entscheidung statt zu einer Gewohnheit.
    expect(Object.keys(report).sort()).toEqual([
      "currency",
      "missedThreshold",
      "observations",
      "performance",
      "producedPosition",
      "stillOpen",
    ]);
  });
});
