import { describe, expect, it } from "vitest";

import {
  MIN_TRADES_FOR_OUTLIER_VERDICT,
  STANDARD_PERTURBATIONS,
  analyzeOutlierContribution,
  analyzeParameterSensitivity,
  assessFragility,
  type ParameterSensitivity,
} from "../fragility";

/** 40 kleine Verluste plus die angegebenen Gewinner. */
function returns(winners: readonly number[], losers = 40, loss = -0.1): number[] {
  return [...Array.from({ length: losers }, () => loss), ...winners];
}

describe("Beitrag der Ausreisser", () => {
  it("erkennt ein Ergebnis, das an einem Trade haengt", () => {
    // 40 × −0,1 = −4,0, ein Gewinner mit +5,0 → gesamt +1,0.
    const result = analyzeOutlierContribution(returns([5.0]));

    expect(result.totalReturn).toBeCloseTo(1.0, 6);
    expect(result.withoutBest).toBeCloseTo(-4.0, 6);
    expect(result.signFlipsWithoutBest).toBe(true);
    expect(result.verdict).toBe("CARRIED_BY_OUTLIERS");
    expect(result.note).toMatch(/Gluecksfall/);
  });

  it("nennt ein breit getragenes Ergebnis robust", () => {
    const result = analyzeOutlierContribution(returns(Array.from({ length: 40 }, () => 0.3)));
    expect(result.signFlipsWithoutBest).toBe(false);
    expect(result.signFlipsWithoutTopFive).toBe(false);
    expect(result.verdict).toBe("ROBUST");
  });

  it("sieht auch die Konzentration auf fuenf Trades", () => {
    // Einzeln kippt keiner das Ergebnis, zusammen schon.
    const result = analyzeOutlierContribution(returns([1.2, 1.2, 1.2, 1.2, 1.2]));
    expect(result.signFlipsWithoutBest).toBe(false);
    expect(result.signFlipsWithoutTopFive).toBe(true);
    expect(result.verdict).toBe("CARRIED_BY_OUTLIERS");
  });

  it("urteilt nicht bei zu wenigen Trades", () => {
    const result = analyzeOutlierContribution([1, -0.1, -0.1]);
    expect(result.verdict).toBe("TOO_LITTLE_DATA");
    expect(result.bestShare).toBeNull();
    expect(MIN_TRADES_FOR_OUTLIER_VERDICT).toBeGreaterThan(10);
  });

  it("gibt bei negativem Gesamtergebnis keinen Anteil an", () => {
    // „Anteil am Ergebnis" ist bei einem Verlust keine verstaendliche Groesse.
    const result = analyzeOutlierContribution(returns([0.5], 40, -0.2));
    expect(result.totalReturn).toBeLessThan(0);
    expect(result.bestShare).toBeNull();
  });
});

describe("Parameter-Empfindlichkeit", () => {
  it("erkennt ein Plateau", () => {
    const result = analyzeParameterSensitivity({
      parameter: "stopLossBps",
      baseValue: 2_000,
      evaluate: (v) => 100 - Math.abs(v - 2_000) * 0.002,
    });
    expect(result.shape).toBe("PLATEAU");
    expect(result.worstRelativeDrop!).toBeLessThan(0.1);
  });

  it("erkennt einen Gipfel als Overfitting-Signatur", () => {
    // Faellt in beide Richtungen steil ab — genau das entsteht in verrauschten
    // Oberflaechen von selbst, wenn man 45 Kombinationen durchprobiert.
    const result = analyzeParameterSensitivity({
      parameter: "takeProfit1",
      baseValue: 2_500,
      evaluate: (v) => 100 - Math.abs(v - 2_500) * 0.9,
    });
    expect(result.shape).toBe("PEAK");
    expect(result.note).toMatch(/Spitze/);
  });

  it("erkennt eine nicht abgeschlossene Suche", () => {
    const result = analyzeParameterSensitivity({
      parameter: "minScore",
      baseValue: 75,
      evaluate: (v) => v, // je hoeher, desto besser — die Grenze wurde gesetzt
    });
    expect(result.shape).toBe("SLOPE");
    expect(result.bestRelativeGain!).toBeGreaterThan(0.15);
  });

  it("prueft die vorgeschriebenen Auslenkungen", () => {
    expect(STANDARD_PERTURBATIONS).toContain(0.05);
    expect(STANDARD_PERTURBATIONS).toContain(-0.1);
    expect(STANDARD_PERTURBATIONS).toContain(0.2);
    const result = analyzeParameterSensitivity({
      parameter: "x",
      baseValue: 100,
      evaluate: () => 50,
    });
    expect(result.points).toHaveLength(STANDARD_PERTURBATIONS.length);
  });

  it("behandelt ein Basisergebnis von null nicht als neutral", () => {
    // Ohne verwertbares Basisergebnis ist jede relative Aenderung undefiniert.
    const result = analyzeParameterSensitivity({
      parameter: "x",
      baseValue: 100,
      evaluate: (v) => (v === 100 ? 0 : 10),
    });
    expect(result.shape).toBe("NOT_EVALUABLE");
    expect(result.worstRelativeDrop).toBeNull();
  });

  it("kommt mit nicht auswertbaren Auslenkungen zurecht", () => {
    const result = analyzeParameterSensitivity({
      parameter: "x",
      baseValue: 100,
      evaluate: (v) => (v > 100 ? 90 : null),
    });
    expect(result.points.every((p) => p.delta > 0)).toBe(true);
  });
});

describe("Fragilitaet als Gate", () => {
  const plateau: ParameterSensitivity = {
    parameter: "stop",
    baseValue: 2_000,
    baseResult: 100,
    points: [],
    worstRelativeDrop: 0.05,
    bestRelativeGain: 0.02,
    shape: "PLATEAU",
    note: "",
  };
  const peak: ParameterSensitivity = { ...plateau, parameter: "tp1", shape: "PEAK" };

  it("blockiert einen Kandidaten, der an einem Trade haengt", () => {
    const result = assessFragility({
      netReturns: returns([5.0]),
      parameters: [plateau],
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons.join(" ")).toMatch(/besten Trade/);
  });

  it("blockiert einen Kandidaten mit einem Gipfel-Parameter", () => {
    const result = assessFragility({
      netReturns: returns(Array.from({ length: 40 }, () => 0.3)),
      parameters: [plateau, peak],
    });
    expect(result.blocked).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it("laesst einen breit getragenen, stabilen Kandidaten durch", () => {
    const result = assessFragility({
      netReturns: returns(Array.from({ length: 40 }, () => 0.3)),
      parameters: [plateau],
    });
    expect(result.blocked).toBe(false);
    expect(result.score).toBe(0);
  });

  it("rechnet gute Kennzahlen nicht gegen einen Befund auf", () => {
    // Ein Ergebnis, das an einem Parameterwert haengt, wird nicht dadurch
    // tragfaehig, dass alles andere gut aussieht.
    const result = assessFragility({
      netReturns: returns(Array.from({ length: 200 }, () => 0.3)),
      parameters: [plateau, plateau, plateau, peak],
    });
    expect(result.blocked).toBe(true);
  });
});
