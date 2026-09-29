import { expect, it } from "vitest";
import { computePaperLaunchScores } from "../paper-launch";
import { gone, healthyToken } from "./fixtures";

it("computes a launch score without inventing historical momentum", () => {
  const v = healthyToken();
  const launch = { ...v, momentum: { ...v.momentum, priceChange5m: gone<number>(), priceChange1h: gone<number>(), volumeAcceleration: gone<number>() } };
  const result = computePaperLaunchScores(launch);
  expect(result.finalScore).toBeGreaterThan(50);
  expect(result.dataCompleteness).toBe(1);
  expect(result.scoreEngineVersion).toBe("paper-launch-1.0.0");
  expect(result.missingFields.some((f) => f.field === "momentum.priceChange5m")).toBe(true);
  expect(launch.momentum.priceChange5m.kind).toBe("MISSING");
});

it("cannot form a score with missing authority or exit data", () => {
  const v = healthyToken();
  for (const launch of [
    { ...v, security: { ...v.security, mintAuthorityActive: gone<boolean>() } },
    { ...v, execution: { ...v.execution, exitCapacityRatio: gone<number>() } },
  ]) {
    const result = computePaperLaunchScores(launch);
    expect(result.finalScore).toBeNull();

  }
});
