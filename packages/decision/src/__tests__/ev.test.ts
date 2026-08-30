import { describe, expect, it } from "vitest";
import { estimateEv, wilsonLowerBound, type OutcomeSample } from "../ev";

const sample = (returns: number[]): OutcomeSample[] => returns.map((netReturn) => ({ netReturn }));

describe("wilsonLowerBound", () => {
  it("liefert bei drei von drei Treffern nicht 100 Prozent", () => {
    // Der naive Anteil saehe hier nach einer sicheren Sache aus.
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.5);
  });

  it("naehert sich mit wachsender Stichprobe dem Anteil", () => {
    const small = wilsonLowerBound(30, 50);
    const large = wilsonLowerBound(600, 1_000);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeCloseTo(0.6, 1);
  });

  it("liefert bei leerer Stichprobe 0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("estimateEv", () => {
  it("meldet UNKNOWN unterhalb der Mindeststichprobe", () => {
    const result = estimateEv({
      sample: sample([0.5, -0.2, 0.3]),
      expectedCostFraction: 0.02,
      minSampleSize: 100,
    });
    expect(result.estimate.kind).toBe("UNKNOWN");
    // Ausdruecklich kein Ersatzwert: null heisst null, nicht 0.
    expect(result.pointEv).toBeNull();
    expect(result.conservativeEv).toBeNull();
  });

  it("schaetzt aus einer ausreichenden Stichprobe", () => {
    const returns = [
      ...Array.from({ length: 60 }, () => 0.4),
      ...Array.from({ length: 40 }, () => -0.2),
    ];
    const result = estimateEv({
      sample: sample(returns),
      expectedCostFraction: 0.02,
      minSampleSize: 100,
    });
    expect(result.estimate.kind).toBe("ESTIMATED");
    expect(result.winRate).toBeCloseTo(0.6, 4);
    expect(result.avgWin).toBeCloseTo(0.4, 4);
    expect(result.avgLoss).toBeCloseTo(0.2, 4);
    // 0.6 * 0.4 - 0.4 * 0.2 - 0.02 = 0.14
    expect(result.pointEv).toBeCloseTo(0.14, 4);
  });

  it("bleibt konservativ unter der Punktschaetzung", () => {
    const returns = [
      ...Array.from({ length: 60 }, () => 0.4),
      ...Array.from({ length: 40 }, () => -0.2),
    ];
    const result = estimateEv({
      sample: sample(returns),
      expectedCostFraction: 0.02,
      minSampleSize: 100,
    });
    expect(result.conservativeEv!).toBeLessThan(result.pointEv!);
  });

  it("zieht die Kosten ab", () => {
    const returns = [...Array.from({ length: 50 }, () => 0.1), ...Array.from({ length: 50 }, () => -0.1)];
    const free = estimateEv({ sample: sample(returns), expectedCostFraction: 0, minSampleSize: 10 });
    const costly = estimateEv({
      sample: sample(returns),
      expectedCostFraction: 0.05,
      minSampleSize: 10,
    });
    expect(costly.pointEv!).toBeCloseTo(free.pointEv! - 0.05, 6);
  });

  it("dreht einen scheinbar guten Trade durch Kosten ins Negative", () => {
    // Der Fall, den Backtests mit Null-Kosten uebersehen.
    const returns = [...Array.from({ length: 55 }, () => 0.05), ...Array.from({ length: 45 }, () => -0.04)];
    const result = estimateEv({
      sample: sample(returns),
      expectedCostFraction: 0.02,
      minSampleSize: 10,
    });
    expect(result.pointEv!).toBeLessThan(0);
  });

  it("sinkt in der Konfidenz bei breitem Intervall", () => {
    const small = estimateEv({
      sample: sample([...Array(8).fill(0.3), ...Array(2).fill(-0.1)]),
      expectedCostFraction: 0,
      minSampleSize: 10,
    });
    const large = estimateEv({
      sample: sample([...Array(800).fill(0.3), ...Array(200).fill(-0.1)]),
      expectedCostFraction: 0,
      minSampleSize: 10,
    });
    if (small.estimate.kind === "ESTIMATED" && large.estimate.kind === "ESTIMATED") {
      expect(large.estimate.confidence).toBeGreaterThan(small.estimate.confidence);
    }
  });
});
