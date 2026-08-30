import { describe, expect, it } from "vitest";
import { bps } from "@sae/core";
import {
  DEFAULT_EMERGENCY_IMPACT_BPS,
  MAX_TOLERABLE_EMERGENCY_IMPACT_BPS,
  planEmergencyExit,
} from "../emergency-exit";

const base = {
  acceptableImpactBps: DEFAULT_EMERGENCY_IMPACT_BPS,
  maxTolerableImpactBps: MAX_TOLERABLE_EMERGENCY_IMPACT_BPS,
  maxTranches: 5,
};

describe("planEmergencyExit", () => {
  it("verkauft alles auf einmal, wenn die Tiefe reicht", () => {
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 1_000n,
      poolTokenReserve: 10_000_000n,
    });
    expect(plan.kind).toBe("SELL_FULL");
  });

  it("teilt in Tranchen, wenn die Tiefe fuer alles auf einmal nicht reicht", () => {
    // Der Reflex waere, sofort alles auf den Markt zu werfen — und genau das
    // realisiert den maximalen Schaden.
    // Reserve 1.000.000, 5 % Impact-Grenze -> 52.631 je Tranche, also 3 Tranchen.
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 150_000n,
      poolTokenReserve: 1_000_000n,
    });
    expect(plan.kind).toBe("SELL_IN_TRANCHES");
    if (plan.kind === "SELL_IN_TRANCHES") {
      expect(plan.trancheCount).toBeGreaterThan(1);
      expect(plan.trancheCount).toBeLessThanOrEqual(base.maxTranches);
    }
  });

  it("nimmt lieber hoeheren Impact als zu viele Transaktionen", () => {
    // 150.000 braucht bei 5 % drei Tranchen, erlaubt sind zwei. Bei 15 % gehen
    // 176.470 auf einmal — jede zusaetzliche Transaktion ist im Notfall selbst
    // ein Risiko, weil der Kurs zwischen ihnen weiterlaeuft.
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 150_000n,
      poolTokenReserve: 1_000_000n,
      maxTranches: 2,
    });
    expect(plan.kind).toBe("SELL_FULL");
    if (plan.kind === "SELL_FULL") {
      expect(plan.expectedImpactBps).toBe(MAX_TOLERABLE_EMERGENCY_IMPACT_BPS);
    }
  });

  it("teilt notfalls in groessere Tranchen zum hoeheren Impact", () => {
    // 300.000 geht auch bei 15 % nicht auf einmal (176.470), aber in zwei
    // groesseren Tranchen — besser als aufgeben.
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 300_000n,
      poolTokenReserve: 1_000_000n,
      maxTranches: 3,
    });
    expect(plan.kind).toBe("SELL_IN_TRANCHES");
    if (plan.kind === "SELL_IN_TRANCHES") {
      expect(plan.expectedImpactBps).toBe(MAX_TOLERABLE_EMERGENCY_IMPACT_BPS);
      expect(plan.trancheCount).toBe(2);
    }
  });

  it("meldet, wenn kein sinnvoller Ausstieg moeglich ist", () => {
    // Eine Feststellung, keine Handlungsanweisung: hier muss ein Mensch ran.
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 5_000_000n,
      poolTokenReserve: 1_000_000n,
      maxTranches: 3,
    });
    expect(plan.kind).toBe("NO_VIABLE_EXIT");
  });

  it("meldet einen leeren Pool", () => {
    const plan = planEmergencyExit({ ...base, positionAmount: 100n, poolTokenReserve: 0n });
    expect(plan.kind).toBe("NO_VIABLE_EXIT");
  });

  it("meldet eine leere Position", () => {
    const plan = planEmergencyExit({ ...base, positionAmount: 0n, poolTokenReserve: 1_000n });
    expect(plan.kind).toBe("NO_VIABLE_EXIT");
  });

  it("haelt jede Tranche innerhalb der Impact-Grenze", () => {
    const plan = planEmergencyExit({
      ...base,
      positionAmount: 200_000n,
      poolTokenReserve: 2_000_000n,
      acceptableImpactBps: bps(300),
    });
    if (plan.kind === "SELL_IN_TRANCHES") {
      expect(plan.trancheAmount).toBeLessThanOrEqual(200_000n);
      expect(plan.expectedImpactBps).toBe(300);
    }
  });
});
