import { describe, expect, it } from "vitest";

import {
  ALL_GATES,
  evaluatePromotionGates,
  type PromotionDecision,
  type PromotionEvidence,
} from "../promotion";
import { assessFragility, type ParameterSensitivity } from "../fragility";
import { runMonteCarlo } from "../monte-carlo";
import type { ShadowComparison } from "../shadow";

const plateau: ParameterSensitivity = {
  parameter: "stopLossBps",
  baseValue: 2_000,
  baseResult: 100,
  points: [],
  worstRelativeDrop: 0.05,
  bestRelativeGain: 0.02,
  shape: "PLATEAU",
  note: "",
};

const goodShadow = {
  championId: "champ",
  challengerId: "chall",
  pairs: [],
  counts: { BOTH_ENTER: 300, CHAMPION_ONLY: 200, CHALLENGER_ONLY: 200, BOTH_SKIP: 100 },
  championOnly: { count: 200, resolvedCount: 200, winRate: 0.3, interval: { lower: 0.24, upper: 0.37 }, meanReturn: -0.02 },
  challengerOnly: { count: 200, resolvedCount: 200, winRate: 0.6, interval: { lower: 0.53, upper: 0.66 }, meanReturn: 0.12 },
  agreementRate: 0.5,
  verdict: "CHALLENGER_BETTER",
  note: "Intervalle getrennt.",
} satisfies ShadowComparison;

const steady = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? -0.2 : 0.15));

function evidence(overrides: Partial<PromotionEvidence> = {}): PromotionEvidence {
  return {
    candidateId: "cand-1",
    resolvedTradeCount: 400,
    outOfSample: { netReturn: 0.18, batchId: "batch-1" },
    positiveWindowShare: 0.8,
    windowCount: 10,
    shadow: goodShadow,
    fragility: assessFragility({ netReturns: steady, parameters: [plateau] }),
    monteCarlo: runMonteCarlo(steady, { paths: 400, seed: 4, stakeFraction: 0.02 }),
    costModelCalibrated: true,
    ...overrides,
  };
}

const statusOf = (d: PromotionDecision, gate: string) =>
  d.gates.find((g) => g.gate === gate)!.status;

describe("Promotionsgates", () => {
  it("prueft genau zehn Gates", () => {
    const decision = evaluatePromotionGates(evidence());
    expect(decision.gates).toHaveLength(10);
    expect(decision.gates.map((g) => g.gate).sort()).toEqual([...ALL_GATES].sort());
  });

  it("kann keine Freigabe erteilen", () => {
    const decision = evaluatePromotionGates(evidence());

    // Der ganze Zweck: kein Codepfad setzt HUMAN_APPROVAL auf PASS.
    expect(statusOf(decision, "HUMAN_APPROVAL")).toBe("REQUIRES_HUMAN");
    expect(Object.keys(decision)).not.toContain("approved");
    expect(Object.keys(decision)).not.toContain("promoted");
    expect(decision.readyForHumanReview).toBe(true);
    expect(decision.summary).toMatch(/Freigabe durch einen Menschen steht aus/);
  });

  it("laesst ein einzelnes durchgefallenes Gate den Rest nicht ueberstimmen", () => {
    // Neun bestanden, eines knapp verfehlt — ein Durchschnitt ueber Gates
    // verwandelt jede harte Bedingung in eine Empfehlung.
    const decision = evaluatePromotionGates(evidence({ outOfSample: { netReturn: -0.05, batchId: "b" } }));

    expect(decision.failed).toEqual(["OUT_OF_SAMPLE"]);
    expect(decision.readyForHumanReview).toBe(false);
  });

  it("behandelt ein nicht bewertetes Gate wie ein durchgefallenes", () => {
    const decision = evaluatePromotionGates(evidence({ shadow: null }));
    expect(statusOf(decision, "SHADOW_BEATS_CHAMPION")).toBe("NOT_EVALUATED");
    expect(decision.readyForHumanReview).toBe(false);
    // Getrennt ausgewiesen, aber mit derselben Folge.
    expect(decision.notEvaluated).toContain("SHADOW_BEATS_CHAMPION");
    expect(decision.failed).not.toContain("SHADOW_BEATS_CHAMPION");
  });

  it("faellt ohne kalibriertes Kostenmodell durch", () => {
    // Der derzeitige Zustand: kein Provider erreichbar, also keine Kalibrierung.
    const decision = evaluatePromotionGates(evidence({ costModelCalibrated: false }));
    expect(statusOf(decision, "COST_MODEL_CALIBRATED")).toBe("FAIL");
    expect(decision.readyForHumanReview).toBe(false);
  });

  it("verlangt Bestaendigkeit ueber die Fenster, nicht ein gutes Fenster", () => {
    const decision = evaluatePromotionGates(evidence({ positiveWindowShare: 0.3, windowCount: 10 }));
    expect(statusOf(decision, "WALK_FORWARD_CONSISTENCY")).toBe("FAIL");
    expect(decision.gates.find((g) => g.gate === "WALK_FORWARD_CONSISTENCY")!.detail).toMatch(
      /wenigen guten Phasen/,
    );
  });

  it("lehnt einen Herausforderer ab, der nur anders ist", () => {
    const decision = evaluatePromotionGates(
      evidence({ shadow: { ...goodShadow, verdict: "NO_DIFFERENCE" } }),
    );
    expect(statusOf(decision, "SHADOW_BEATS_CHAMPION")).toBe("FAIL");
  });

  it("lehnt ein Ergebnis ab, das an einem Trade haengt", () => {
    const carried = [...Array.from({ length: 40 }, () => -0.1), 5.0];
    const decision = evaluatePromotionGates(
      evidence({ fragility: assessFragility({ netReturns: carried, parameters: [plateau] }) }),
    );
    expect(statusOf(decision, "OUTLIER_ROBUSTNESS")).toBe("FAIL");
  });

  it("lehnt einen Parameter auf einer Spitze ab", () => {
    const peak: ParameterSensitivity = { ...plateau, parameter: "tp1", shape: "PEAK" };
    const decision = evaluatePromotionGates(
      evidence({ fragility: assessFragility({ netReturns: steady, parameters: [plateau, peak] }) }),
    );
    expect(statusOf(decision, "PARAMETER_SENSITIVITY")).toBe("FAIL");
  });

  it("lehnt einen zu grossen simulierten Rueckgang ab", () => {
    // Verteilung mit negativem Erwartungswert: ein Zehntel Verzehnfacher,
    // neun Zehntel -40 %. Der Endstand kann gut aussehen, der Weg dorthin nicht.
    const volatile = Array.from({ length: 300 }, (_, i) => (i % 10 === 0 ? 2.0 : -0.4));
    const decision = evaluatePromotionGates(
      evidence({
        monteCarlo: runMonteCarlo(volatile, { paths: 400, seed: 2, stakeFraction: 0.15 }),
      }),
    );

    expect(statusOf(decision, "DRAWDOWN_LIMIT")).toBe("FAIL");
    expect(statusOf(decision, "RISK_OF_RUIN")).toBe("FAIL");
    expect(decision.gates.find((g) => g.gate === "DRAWDOWN_LIMIT")!.detail).toMatch(
      /keinen Erwartungswert mehr/,
    );
  });

  it("nennt jedes durchgefallene Gate beim Namen", () => {
    const decision = evaluatePromotionGates(
      evidence({
        resolvedTradeCount: 10,
        outOfSample: null,
        costModelCalibrated: false,
      }),
    );
    expect(decision.failed).toContain("SAMPLE_SIZE");
    expect(decision.failed).toContain("COST_MODEL_CALIBRATED");
    expect(decision.notEvaluated).toContain("OUT_OF_SAMPLE");
    expect(decision.summary).toMatch(/Nicht vorlegbar/);
  });
});
