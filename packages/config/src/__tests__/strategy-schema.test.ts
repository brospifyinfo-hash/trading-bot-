import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_STATE,
  DEFAULT_STRATEGY_PARAMETERS,
  parseStrategyParameters,
  strategyParametersSchema,
} from "../index";
import { HARD_LIMITS } from "../risk-limits";

const base = () => structuredClone(DEFAULT_STRATEGY_PARAMETERS);

describe("Standardkonfiguration", () => {
  it("startet mit deaktiviertem Live-Trading", () => {
    // Der wichtigste Default des ganzen Systems.
    expect(DEFAULT_SYSTEM_STATE.liveTradingEnabled).toBe(false);
    expect(DEFAULT_SYSTEM_STATE.emergencyStop).toBe(false);
  });

  it("ist gegen das eigene Schema gueltig", () => {
    expect(() => parseStrategyParameters(DEFAULT_STRATEGY_PARAMETERS)).not.toThrow();
  });

  it("bleibt unter allen harten Obergrenzen", () => {
    const r = DEFAULT_STRATEGY_PARAMETERS.risk;
    expect(r.maxPositionPct).toBeLessThanOrEqual(HARD_LIMITS.maxPositionPctOfPortfolio);
    expect(r.maxDailyLossPct).toBeLessThanOrEqual(HARD_LIMITS.maxDailyLossPct);
    expect(r.maxOpenPositions).toBeLessThanOrEqual(HARD_LIMITS.maxOpenPositions);
    expect(r.maxSlippageBps).toBeLessThanOrEqual(HARD_LIMITS.maxSlippageBps);
  });
});

describe("Harte Obergrenzen", () => {
  it("lehnt eine Positionsgroesse ueber der Obergrenze ab", () => {
    const p = base();
    p.risk.maxPositionPct = HARD_LIMITS.maxPositionPctOfPortfolio + 1;
    expect(() => parseStrategyParameters(p)).toThrow();
  });

  it("lehnt ein Tagesverlustlimit ueber der Obergrenze ab", () => {
    const p = base();
    p.risk.maxDailyLossPct = HARD_LIMITS.maxDailyLossPct + 0.1;
    expect(() => parseStrategyParameters(p)).toThrow();
  });

  it("lehnt eine Slippage-Toleranz ueber der Obergrenze ab", () => {
    const p = base();
    p.risk.maxSlippageBps = HARD_LIMITS.maxSlippageBps + 1;
    expect(() => parseStrategyParameters(p)).toThrow();
  });
});

describe("Take-Profit-Stufen", () => {
  it("lehnt Stufen ab, die zusammen mehr als 100 % verkaufen", () => {
    const p = base();
    p.exit.takeProfits = [
      { index: 1, triggerGainBps: 2_500, sellPortionBps: 6_000 },
      { index: 2, triggerGainBps: 5_000, sellPortionBps: 5_000 },
    ];
    expect(() => parseStrategyParameters(p)).toThrow(/mehr als die Position hergibt/);
  });

  it("lehnt doppelte Indizes ab", () => {
    const p = base();
    p.exit.takeProfits = [
      { index: 1, triggerGainBps: 2_500, sellPortionBps: 2_000 },
      { index: 1, triggerGainBps: 5_000, sellPortionBps: 2_000 },
    ];
    expect(() => parseStrategyParameters(p)).toThrow(/doppelte Indizes/);
  });

  it("lehnt nicht aufsteigende Ausloeseschwellen ab", () => {
    const p = base();
    p.exit.takeProfits = [
      { index: 1, triggerGainBps: 5_000, sellPortionBps: 2_000 },
      { index: 2, triggerGainBps: 2_500, sellPortionBps: 2_000 },
    ];
    expect(() => parseStrategyParameters(p)).toThrow(/loest nicht spaeter aus/);
  });

  it("lehnt einen Trailing Stop ohne verbleibenden Runner ab", () => {
    // 100 % verkauft und trotzdem Trailing Stop konfiguriert waere eine stille
    // Fehlkonfiguration: die Regel wuerde nie greifen.
    const p = base();
    p.exit.takeProfits = [{ index: 1, triggerGainBps: 2_500, sellPortionBps: 10_000 }];
    p.exit.trailingStopBps = 1_500;
    expect(() => parseStrategyParameters(p)).toThrow(/kein Runner/);
  });

  it("akzeptiert Stufen, die zusammen weniger als 100 % verkaufen", () => {
    const p = base();
    const total = p.exit.takeProfits.reduce((s, tp) => s + tp.sellPortionBps, 0);
    expect(total).toBeLessThan(10_000);
    expect(() => parseStrategyParameters(p)).not.toThrow();
  });
});

describe("EV-Gate", () => {
  it("verlangt eine Mindest-Stichprobengroesse von mindestens 1", () => {
    const p = base();
    p.entryGates.minEvSampleSize = 0;
    expect(strategyParametersSchema.safeParse(p).success).toBe(false);
  });

  it("setzt die Stichprobenschwelle standardmaessig hoch genug fuer eine Aussage", () => {
    // Unter ~100 Trades ist eine Win-Rate-Schaetzung im Wesentlichen Rauschen.
    expect(DEFAULT_STRATEGY_PARAMETERS.entryGates.minEvSampleSize).toBeGreaterThanOrEqual(100);
  });
});
