import { describe, expect, it } from "vitest";

import {
  analyzeDecay,
  analyzeFeature,
  analyzeInteraction,
  analyzeMarginalValue,
  type FeatureObservation,
} from "../feature-analysis";
import { adjustedZ, expectedFalsePositives, normalQuantile } from "../multiple-testing";

const T0 = Date.UTC(2026, 0, 1);
const day = (n: number): Date => new Date(T0 + n * 86_400_000);

/** n Beobachtungen mit fester Trefferquote, gleichmaessig ueber `days` verteilt. */
function make(
  count: number,
  winRate: number,
  featureValue: number | null,
  days = 100,
  offset = 0,
): FeatureObservation[] {
  const wins = Math.round(count * winRate);
  return Array.from({ length: count }, (_, i) => ({
    featureValue,
    netReturn: i < wins ? 0.4 : -0.2,
    at: day(offset + (i / count) * days),
  }));
}

describe("Vielfaches Testen", () => {
  it("liefert bei einem Test das vertraute 1,96", () => {
    expect(adjustedZ(1)).toBeCloseTo(1.96, 2);
  });

  it("verbreitert das Intervall mit der Zahl der Versuche", () => {
    // 45 Features gegen drei Schwellen sind 135 Versuche.
    expect(adjustedZ(135)).toBeGreaterThan(3.4);
    expect(adjustedZ(135)).toBeLessThan(3.7);
  });

  it("beziffert die zu erwartenden Scheinbefunde", () => {
    expect(expectedFalsePositives(135)).toBeCloseTo(6.75, 2);
  });

  it("ist symmetrisch um den Median", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(-normalQuantile(0.025), 6);
  });
});

describe("Feature-Beitrag", () => {
  it("erkennt einen deutlichen Unterschied", () => {
    const result = analyzeFeature({
      feature: "distinctActors",
      threshold: 40,
      observations: [...make(400, 0.55, 60), ...make(400, 0.25, 10)],
    });

    expect(result.verdict).toBe("SEPARATED");
    expect(result.better).toBe("ABOVE");
    expect(result.winRateGap!).toBeGreaterThan(0.2);
  });

  it("urteilt nicht bei zu kleiner Gruppe", () => {
    const result = analyzeFeature({
      feature: "distinctActors",
      threshold: 40,
      observations: [...make(400, 0.55, 60), ...make(20, 0.1, 10)],
    });
    // Eine grosse Gesamtzahl rettet keine kleine Gruppe.
    expect(result.verdict).toBe("TOO_LITTLE_DATA");
    expect(result.winRateGap).toBeNull();
  });

  it("nennt ueberlappende Intervalle keinen Unterschied", () => {
    const result = analyzeFeature({
      feature: "distinctActors",
      threshold: 40,
      observations: [...make(200, 0.42, 60), ...make(200, 0.38, 10)],
    });
    expect(result.verdict).toBe("NO_DIFFERENCE");
    expect(result.better).toBeNull();
  });

  it("laesst denselben Befund bei vielen Versuchen durchfallen", () => {
    // Derselbe Datensatz, einmal als einziger Test und einmal als einer von 135.
    const observations = [...make(200, 0.56, 60), ...make(200, 0.36, 10)];
    const alone = analyzeFeature({ feature: "f", threshold: 40, observations });
    const amongMany = analyzeFeature({
      feature: "f",
      threshold: 40,
      observations,
      settings: { comparisons: 135 },
    });

    expect(alone.verdict).toBe("SEPARATED");
    expect(amongMany.verdict).toBe("NO_DIFFERENCE");
    expect(amongMany.note).toMatch(/Scheinbefunde/);
  });

  it("zaehlt fehlende Werte, statt sie zu ersetzen", () => {
    const result = analyzeFeature({
      feature: "smartMoneyBuyers",
      threshold: 3,
      observations: [...make(150, 0.5, 5), ...make(150, 0.3, 1), ...make(90, 0.4, null)],
    });
    expect(result.missingCount).toBe(90);
    expect(result.above.count + result.below.count).toBe(300);
  });
});

describe("Wechselwirkung", () => {
  const cell = (count: number, winRate: number, a: number, b: number) => {
    const wins = Math.round(count * winRate);
    return Array.from({ length: count }, (_, i) => ({
      a,
      b,
      netReturn: i < wins ? 0.4 : -0.2,
    }));
  };

  it("verlangt vier belegte Zellen", () => {
    const result = analyzeInteraction({
      featureA: "a",
      featureB: "b",
      thresholdA: 1,
      thresholdB: 1,
      observations: [
        ...cell(300, 0.6, 2, 2),
        ...cell(300, 0.4, 2, 0),
        ...cell(300, 0.4, 0, 2),
        ...cell(5, 0.2, 0, 0),
      ],
    });
    // Eine fast leere Zelle ergaebe eine Wechselwirkung, die an fuenf Trades haengt.
    expect(result.kind).toBe("TOO_LITTLE_DATA");
  });

  it("erkennt Redundanz zweier Features", () => {
    const result = analyzeInteraction({
      featureA: "a",
      featureB: "b",
      thresholdA: 1,
      thresholdB: 1,
      observations: [
        ...cell(400, 0.55, 2, 2),
        ...cell(400, 0.55, 2, 0),
        ...cell(400, 0.55, 0, 2),
        ...cell(400, 0.25, 0, 0),
      ],
    });
    // Jedes Feature allein hebt auf 55 %, zusammen auch — sie sagen dasselbe.
    expect(result.kind).toBe("REDUNDANT");
    expect(result.excessOverAdditive!).toBeLessThan(0);
  });

  it("erkennt einen additiven Fall als additiv", () => {
    const result = analyzeInteraction({
      featureA: "a",
      featureB: "b",
      thresholdA: 1,
      thresholdB: 1,
      observations: [
        ...cell(400, 0.5, 2, 2),
        ...cell(400, 0.4, 2, 0),
        ...cell(400, 0.4, 0, 2),
        ...cell(400, 0.3, 0, 0),
      ],
    });
    expect(result.kind).toBe("ADDITIVE");
  });
});

describe("Grenznutzen", () => {
  it("misst auf derselben Menge", () => {
    const result = analyzeMarginalValue({
      feature: "liquidity",
      threshold: 50,
      observations: [...make(200, 0.6, 80), ...make(200, 0.1, 10)],
    });

    expect(result.verdict).toBe("MEASURED");
    expect(result.excludedCount).toBe(200);
    expect(result.marginalPerTrade!).toBeGreaterThan(0);
  });

  it("meldet ein Gate, das nichts verhindert haette", () => {
    const result = analyzeMarginalValue({
      feature: "liquidity",
      threshold: 5,
      observations: make(200, 0.5, 80),
    });
    expect(result.verdict).toBe("GATE_CHANGES_NOTHING");
  });

  it("schliesst Trades ohne Featurewert nicht still aus", () => {
    // Sie stillschweigend zu entfernen waere die bequemste Art, ein Gate gut
    // aussehen zu lassen.
    const result = analyzeMarginalValue({
      feature: "smartMoney",
      threshold: 3,
      observations: [...make(150, 0.6, 5), ...make(150, 0.1, 1), ...make(100, 0.2, null)],
    });
    expect(result.keptCount).toBe(250);
    expect(result.excludedCount).toBe(150);
  });
});

describe("Zerfall", () => {
  it("erkennt einen echten Rueckgang", () => {
    const early = make(300, 0.65, 60, 40, 0);
    const late = make(300, 0.2, 60, 40, 60);
    const result = analyzeDecay({
      feature: "momentum",
      threshold: 10,
      observations: [...early, ...late],
      blocks: 2,
    });

    expect(result.direction).toBe("DECAYING");
    expect(result.blocks).toHaveLength(2);
  });

  it("behauptet keinen Trend bei ueberlappenden Intervallen", () => {
    const result = analyzeDecay({
      feature: "momentum",
      threshold: 10,
      observations: [...make(300, 0.45, 60, 40, 0), ...make(300, 0.42, 60, 40, 60)],
      blocks: 2,
    });
    expect(result.direction).toBe("STABLE");
  });

  it("urteilt nicht, wenn ein Block zu duenn ist", () => {
    const result = analyzeDecay({
      feature: "momentum",
      threshold: 10,
      observations: [...make(300, 0.6, 60, 40, 0), ...make(10, 0.1, 60, 5, 60)],
      blocks: 3,
    });
    expect(result.direction).toBe("TOO_LITTLE_DATA");
  });
});
