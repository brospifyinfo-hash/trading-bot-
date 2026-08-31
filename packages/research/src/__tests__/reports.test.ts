import { describe, expect, it } from "vitest";

import {
  assessNoEdge,
  buildResearchReport,
  DEFAULT_NO_EDGE_SETTINGS,
  type ResearchReport,
} from "../reports";
import type { FeaturePerformance, InteractionResult } from "../feature-analysis";
import type { ShadowComparison } from "../shadow";

const emptyBucket = {
  label: "",
  count: 300,
  winRate: 0.5,
  interval: { lower: 0.44, upper: 0.56 },
  meanReturn: 0.1,
  medianReturn: 0.05,
};

function feature(
  verdict: FeaturePerformance["verdict"],
  comparisons = 1,
): FeaturePerformance {
  return {
    feature: "distinctActors",
    threshold: 40,
    above: emptyBucket,
    below: { ...emptyBucket, winRate: 0.3, interval: { lower: 0.25, upper: 0.36 } },
    missingCount: 0,
    verdict,
    winRateGap: verdict === "SEPARATED" ? 0.2 : null,
    better: verdict === "SEPARATED" ? "ABOVE" : null,
    comparisons,
    note: verdict === "SEPARATED" ? "getrennt" : "ueberlappt",
  };
}

const T0 = new Date(Date.UTC(2026, 7, 1));
const at = (days: number): Date => new Date(T0.getTime() + days * 86_400_000);

function report(
  verdict: ResearchReport["verdict"],
  generatedAt: Date,
): ResearchReport {
  return {
    batchId: "b",
    generatedAt,
    confirmed: [],
    noDifference: [],
    inconclusive: [],
    hypothesesTested: 10,
    expectedByChance: 0.5,
    findingsVsChance: 0,
    verdict,
    summary: "",
  };
}

describe("Forschungsbericht", () => {
  it("nimmt nur belegt getrennte Befunde auf", () => {
    const result = buildResearchReport({
      batchId: "batch-1",
      generatedAt: T0,
      features: [feature("SEPARATED"), feature("NO_DIFFERENCE"), feature("TOO_LITTLE_DATA")],
      interactions: [],
      shadows: [],
    });

    // Ein NO_DIFFERENCE ist kein schwacher Befund, sondern keiner.
    expect(result.confirmed).toHaveLength(1);
    expect(result.noDifference).toHaveLength(1);
    expect(result.inconclusive).toHaveLength(1);
  });

  it("stellt die zufaellig erwarteten Befunde daneben", () => {
    // Fuenf Befunde bei 135 Versuchen sind weniger, als der Zufall liefert.
    const result = buildResearchReport({
      batchId: "batch-1",
      generatedAt: T0,
      features: [
        ...Array.from({ length: 5 }, () => feature("SEPARATED", 135)),
        ...Array.from({ length: 130 }, () => feature("NO_DIFFERENCE", 135)),
      ],
      interactions: [],
      shadows: [],
    });

    expect(result.hypothesesTested).toBe(135);
    expect(result.expectedByChance).toBeCloseTo(6.75, 2);
    expect(result.findingsVsChance!).toBeLessThan(1);
    expect(result.verdict).toBe("NO_EDGE");
    expect(result.summary).toMatch(/nicht mehr, als der Zufall liefert/);
  });

  it("nennt einen Vorteil erst, wenn er den Zufall schlaegt", () => {
    const result = buildResearchReport({
      batchId: "batch-1",
      generatedAt: T0,
      features: [
        ...Array.from({ length: 12 }, () => feature("SEPARATED", 20)),
        ...Array.from({ length: 8 }, () => feature("NO_DIFFERENCE", 20)),
      ],
      interactions: [],
      shadows: [],
    });

    expect(result.findingsVsChance!).toBeGreaterThan(1);
    expect(result.verdict).toBe("EDGE_FOUND");
  });

  it("fuehrt „kein Vorteil gefunden“ als Ergebnis", () => {
    const result = buildResearchReport({
      batchId: "batch-1",
      generatedAt: T0,
      features: Array.from({ length: 20 }, () => feature("NO_DIFFERENCE")),
      interactions: [],
      shadows: [],
    });

    expect(result.verdict).toBe("NO_EDGE");
    expect(result.summary).toMatch(/Das ist ein Ergebnis/);
  });

  it("unterscheidet „nichts gefunden“ von „nichts pruefbar“", () => {
    const result = buildResearchReport({
      batchId: "batch-1",
      generatedAt: T0,
      features: Array.from({ length: 20 }, () => feature("TOO_LITTLE_DATA")),
      interactions: [],
      shadows: [],
    });

    // Zu wenig Daten heisst nicht, dass kein Vorteil da ist.
    expect(result.verdict).toBe("INCONCLUSIVE");
    expect(result.summary).toMatch(/zu wenig Daten/);
  });

  it("nimmt Redundanz als Befund auf, Additivitaet nicht", () => {
    const redundant: InteractionResult = {
      featureA: "a",
      featureB: "b",
      cells: {
        bothHigh: emptyBucket,
        aOnly: emptyBucket,
        bOnly: emptyBucket,
        neither: emptyBucket,
      },
      kind: "REDUNDANT",
      excessOverAdditive: -0.1,
      note: "sagen dasselbe",
    };
    const result = buildResearchReport({
      batchId: "b",
      generatedAt: T0,
      features: [],
      interactions: [redundant, { ...redundant, kind: "ADDITIVE", excessOverAdditive: 0 }],
      shadows: [],
    });

    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]!.kind).toBe("INTERACTION");
    expect(result.noDifference).toHaveLength(1);
  });

  it("nimmt einen Shadow-Vergleich mit Trennung auf", () => {
    const shadow: ShadowComparison = {
      championId: "champ",
      challengerId: "chall",
      pairs: [],
      counts: { BOTH_ENTER: 0, CHAMPION_ONLY: 200, CHALLENGER_ONLY: 200, BOTH_SKIP: 0 },
      championOnly: { count: 200, resolvedCount: 200, winRate: 0.3, interval: { lower: 0.24, upper: 0.37 }, meanReturn: -0.02 },
      challengerOnly: { count: 200, resolvedCount: 200, winRate: 0.6, interval: { lower: 0.53, upper: 0.66 }, meanReturn: 0.12 },
      agreementRate: 0,
      verdict: "CHALLENGER_BETTER",
      note: "getrennt",
    };
    const result = buildResearchReport({
      batchId: "b",
      generatedAt: T0,
      features: [],
      interactions: [],
      shadows: [shadow, { ...shadow, verdict: "NO_DIFFERENCE" }],
    });

    expect(result.confirmed.filter((c) => c.kind === "SHADOW")).toHaveLength(1);
  });
});

describe("No-Edge-Modus", () => {
  it("wird nach drei Berichten in Folge aktiv", () => {
    const result = assessNoEdge([
      report("NO_EDGE", at(1)),
      report("NO_EDGE", at(2)),
      report("NO_EDGE", at(3)),
    ]);

    expect(result.active).toBe(true);
    expect(result.consecutiveNoEdge).toBe(3);
    expect(DEFAULT_NO_EDGE_SETTINGS.consecutiveReports).toBe(3);
  });

  it("bricht die Serie bei einem gefundenen Vorteil ab", () => {
    const result = assessNoEdge([
      report("NO_EDGE", at(1)),
      report("EDGE_FOUND", at(2)),
      report("NO_EDGE", at(3)),
    ]);
    expect(result.consecutiveNoEdge).toBe(1);
    expect(result.active).toBe(false);
  });

  it("haelt nur echtes Geld an, nicht die Datenerhebung", () => {
    const result = assessNoEdge([
      report("NO_EDGE", at(1)),
      report("INCONCLUSIVE", at(2)),
      report("NO_EDGE", at(3)),
    ]);

    expect(result.active).toBe(true);
    expect(result.recommendation).toMatch(/Auto Paper und Manual Paper laufen weiter/);
    expect(result.recommendation).toMatch(/nicht das Scheitern/);
  });

  it("kommt mit einer leeren Historie zurecht", () => {
    const result = assessNoEdge([]);
    expect(result.active).toBe(false);
    expect(result.consecutiveNoEdge).toBe(0);
  });
});
