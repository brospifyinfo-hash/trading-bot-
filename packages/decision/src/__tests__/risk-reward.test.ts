import { describe, expect, it } from "vitest";
import { bps, eur } from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY, estimateExecutionCosts } from "@sae/simulation";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";

import { exitCostFactory } from "../realistic-ev";
import { computeRiskReward, type PlannedExitLadder } from "../risk-reward";

const ENTRY = eur(100);
const costBase = {
  dexFeeBps: bps(25),
  solPrice: eur(150),
  fees: DEFAULT_FEES,
  latency: DEFAULT_LATENCY,
} as const;

const entryCost = estimateExecutionCosts({
  ...costBase,
  notional: ENTRY,
  priceImpactBps: bps(30),
});
const exitCostAt = exitCostFactory(costBase, () => bps(30));

const ladder: PlannedExitLadder = {
  stopLossBps: bps(DEFAULT_STRATEGY_PARAMETERS.exit.stopLossBps),
  takeProfits: DEFAULT_STRATEGY_PARAMETERS.exit.takeProfits,
  trailingStopBps: bps(DEFAULT_STRATEGY_PARAMETERS.exit.trailingStopBps ?? 0),
};

function rr(overrides: Partial<Parameters<typeof computeRiskReward>[0]> = {}) {
  return computeRiskReward({
    entryNotional: ENTRY,
    ladder,
    entryCost,
    exitCostAt,
    stopSlippageBps: bps(200),
    ...overrides,
  });
}

describe("Chance und Risiko", () => {
  it("macht den Stop teurer als seinen Abstand", () => {
    const result = rr();
    // 20 % Stop, 2 % Slippage — und dann noch beide Ausfuehrungen.
    expect(result.downsideFraction).toBeGreaterThan(0.22);
  });

  it("wird mit hoeherer Stop-Slippage schlechter, nicht gleich", () => {
    const optimistic = rr({ stopSlippageBps: bps(0) });
    const realistic = rr({ stopSlippageBps: bps(500) });
    expect(realistic.downside.minor).toBeGreaterThan(optimistic.downside.minor);
    expect(realistic.riskReward!).toBeLessThan(optimistic.riskReward!);
  });

  it("rechnet jede Leiterstufe mit ihrem eigenen Volumen", () => {
    const result = rr();
    expect(result.steps).toHaveLength(4);
    // Stufe 4 verkauft bei +200 %: dieselbe Tranchengroesse, viel groesserer
    // Erloes — und damit auch groessere Ausstiegskosten.
    const first = result.steps[0]!;
    const last = result.steps[3]!;
    expect(last.exitCost.minor).toBeGreaterThan(first.exitCost.minor);
    expect(last.netGain.minor).toBeGreaterThan(first.netGain.minor);
  });

  it("bewertet den Rest als Trailing-Untergrenze und sagt das dazu", () => {
    const result = rr();
    // 20+20+25+25 = 90 % verkauft, 10 % laufen weiter.
    expect(result.plannedSellPortionBps).toBe(9_000);
    expect(result.remainderTreatment).toBe("TRAILING_FLOOR");
    expect(result.remainderNetGain.minor).toBeGreaterThan(0n);
    expect(result.caveats.join(" ")).toMatch(/Trailing-Untergrenze/);
  });

  it("laesst einen Rest ohne Plan aus der Chance heraus", () => {
    const withoutTrail = rr({
      ladder: { ...ladder, trailingStopBps: null },
    });
    const withTrail = rr();

    expect(withoutTrail.remainderTreatment).toBe("UNPLANNED");
    expect(withoutTrail.remainderNetGain.minor).toBe(0n);
    expect(withoutTrail.upside.minor).toBeLessThan(withTrail.upside.minor);
    expect(withoutTrail.caveats.join(" ")).toMatch(/keinen geplanten Ausstieg/);
  });

  it("sagt bei jeder Auswertung, dass RR kein Erwartungswert ist", () => {
    // Der haeufigste Denkfehler: RR 5:1 klingt gut und ist bei 10 %
    // Trefferquote ein Verlustgeschaeft.
    expect(rr().caveats[0]).toMatch(/kein Erwartungswert/);
  });

  it("meldet einen Plan, den die Kosten auffressen", () => {
    const tiny: PlannedExitLadder = {
      stopLossBps: bps(2_000),
      takeProfits: [{ index: 1, triggerGainBps: 50, sellPortionBps: 10_000 }],
      trailingStopBps: null,
    };
    const result = rr({ ladder: tiny });

    // +0,5 % Ziel gegen ueber 1 % Round Trip: der Plan kann nicht aufgehen.
    expect(result.upside.minor).toBeLessThan(0n);
    expect(result.riskReward!).toBeLessThan(0);
    expect(result.caveats.join(" ")).toMatch(/Kosten fressen die Leiter/);
  });

  it("meldet einen Stop, der nichts mehr schuetzt", () => {
    const result = rr({
      ladder: { ...ladder, stopLossBps: bps(9_900) },
      stopSlippageBps: bps(200),
    });
    expect(result.caveats.join(" ")).toMatch(/schuetzt nichts mehr/);
  });
});
