import { describe, expect, it } from "vitest";
import { bps } from "@sae/core";
import { assessExitCapacity } from "../exit-capacity";

describe("assessExitCapacity", () => {
  it("erkennt ausreichende Ausstiegsfaehigkeit", () => {
    const r = assessExitCapacity({
      poolTokenReserve: 1_000_000_000n,
      positionAmount: 1_000_000n,
      maxImpactBps: bps(200),
      minCapacityRatio: 3,
    });
    expect(r.sufficient).toBe(true);
    expect(r.capacityRatio).toBeGreaterThan(3);
  });

  it("erkennt einen zu flachen Pool", () => {
    // Position ist ein Zehntel der Reserve — bei 2 % Impact-Grenze unverkaeuflich.
    const r = assessExitCapacity({
      poolTokenReserve: 1_000_000n,
      positionAmount: 100_000n,
      maxImpactBps: bps(200),
      minCapacityRatio: 3,
    });
    expect(r.sufficient).toBe(false);
    expect(r.capacityRatio).toBeLessThan(3);
  });

  it("verliert bei sehr grossen Reserven keine Praezision", () => {
    const r = assessExitCapacity({
      poolTokenReserve: 10n ** 24n,
      positionAmount: 10n ** 18n,
      maxImpactBps: bps(100),
      minCapacityRatio: 3,
    });
    expect(Number.isFinite(r.capacityRatio)).toBe(true);
    expect(r.sufficient).toBe(true);
  });
});
