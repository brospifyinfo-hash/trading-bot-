import { describe, expect, it } from "vitest";
import { bps, eur, type Money } from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY, estimateExecutionCosts } from "@sae/simulation";

import { estimateEv, type OutcomeSample } from "../ev";
import {
  composeRealisticEv,
  exitCostFactory,
  notionalAfterReturn,
} from "../realistic-ev";

const SOL_PRICE = eur(150);
const ENTRY = eur(100);

const costBase = {
  dexFeeBps: bps(25),
  solPrice: SOL_PRICE,
  fees: DEFAULT_FEES,
  latency: DEFAULT_LATENCY,
} as const;

const entryCost = estimateExecutionCosts({
  ...costBase,
  notional: ENTRY,
  priceImpactBps: bps(30),
});

/** Konstanter Impact — als Annahme benannt, nicht versteckt. */
const constantImpact = () => bps(30);
const exitCostAt = exitCostFactory(costBase, constantImpact);

function sample(returns: readonly number[]): OutcomeSample[] {
  return returns.map((netReturn) => ({ netReturn }));
}

/** Zwanzig Trades: sechs Gewinner um +60 %, vierzehn Verlierer um −20 %. */
const GROSS_SAMPLE = sample([
  ...Array.from({ length: 6 }, () => 0.6),
  ...Array.from({ length: 14 }, () => -0.2),
]);

describe("Erwartungswert aus dem echten Kostenmodell", () => {
  it("bucht den Ausstieg mit, nicht nur den Einstieg", () => {
    const realistic = composeRealisticEv({
      sample: GROSS_SAMPLE,
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });
    const entryOnly = estimateEv({
      sample: GROSS_SAMPLE,
      expectedCostFraction: realistic.costs.entryFraction,
      minSampleSize: 10,
    });

    expect(realistic.conservativeEv).not.toBeNull();
    // Ein Trade hat zwei Ausfuehrungen. Wer nur eine bucht, ist zu optimistisch.
    expect(realistic.conservativeEv!).toBeLessThan(entryOnly.conservativeEv!);
    expect(realistic.costs.subtractedFromEv).toBe(true);
  });

  it("rechnet Ausstiegskosten am groesseren Volumen des Gewinnfalls", () => {
    const detail = composeRealisticEv({
      sample: GROSS_SAMPLE,
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });

    // Bei +60 % ist die Verkaufsorder 1,6-mal so gross wie der Einstieg; die
    // prozentualen Posten wirken auf dieses Volumen.
    expect(detail.costs.exitOnWinFraction).toBeGreaterThan(detail.costs.exitOnLossFraction);
    expect(detail.costs.exitOnWinFraction).toBeGreaterThan(detail.costs.entryFraction);
  });

  it("liegt der Breakeven ueber dem reinen Round Trip", () => {
    const detail = composeRealisticEv({
      sample: GROSS_SAMPLE,
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });

    // Weil der Ausstieg am gestiegenen Volumen kostet, reicht es nicht, die
    // Kosten des Round Trips wieder hereinzuholen.
    expect(detail.breakevenReturn).not.toBeNull();
    expect(detail.breakevenReturn!).toBeGreaterThan(detail.costs.roundTripAtFlat);
  });

  it("zieht bei bereits netto gerechneten Renditen nicht noch einmal ab", () => {
    const gross = composeRealisticEv({
      sample: GROSS_SAMPLE,
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });
    const net = composeRealisticEv({
      sample: GROSS_SAMPLE,
      returnBasis: "NET_OF_COSTS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });

    expect(net.conservativeEv!).toBeGreaterThan(gross.conservativeEv!);
    expect(net.costs.subtractedFromEv).toBe(false);
    // Und sagt, was daran nicht stimmt — statt es unsichtbar zu lassen.
    expect(net.caveats.join(" ")).toMatch(/bereits netto/);
  });

  it("weist die Kostenzusammensetzung auch dann aus, wenn kein EV entsteht", () => {
    const detail = composeRealisticEv({
      sample: sample([0.3, -0.1]),
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });

    expect(detail.estimate.kind).toBe("UNKNOWN");
    expect(detail.conservativeEv).toBeNull();
    expect(detail.breakevenReturn).toBeNull();
    // Die Kosten sind bekannt, auch wenn der Erwartungswert es nicht ist.
    expect(detail.costs.entryFraction).toBeGreaterThan(0);
    expect(detail.caveats[0]).toMatch(/Stichprobe/);
  });

  it("merkt an, wenn nur die Punktschaetzung positiv ist", () => {
    // Kleine Stichprobe, hohe Trefferquote: die Punktschaetzung schmeichelt,
    // die Untergrenze nicht.
    const detail = composeRealisticEv({
      sample: sample([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, -0.2, -0.2, -0.2]),
      returnBasis: "GROSS",
      minSampleSize: 10,
      entryNotional: ENTRY,
      entryCost,
      exitCostAt,
    });

    expect(detail.pointEv!).toBeGreaterThan(detail.conservativeEv!);
    if (detail.conservativeEv! <= 0 && detail.pointEv! > 0) {
      expect(detail.caveats.join(" ")).toMatch(/Punktschaetzung/);
    }
  });
});

describe("Ausstiegsvolumen", () => {
  it("waechst mit dem Gewinn", () => {
    expect(notionalAfterReturn(ENTRY, 1.0)).toEqual(eur(200));
    expect(notionalAfterReturn(ENTRY, 0.5)).toEqual(eur(150));
  });

  it("faellt beim Totalverlust auf null statt ins Negative", () => {
    const zero: Money = notionalAfterReturn(ENTRY, -1);
    expect(zero.minor).toBe(0n);
    expect(notionalAfterReturn(ENTRY, -1.5).minor).toBe(0n);
  });

  it("laesst beim wertlosen Ausstieg die Kettenkosten stehen", () => {
    // Ein Verkaufsversuch kostet Gebuehren, auch wenn nichts mehr da ist.
    const cost = exitCostAt(notionalAfterReturn(ENTRY, -1));
    expect(cost.total.minor).toBeGreaterThan(0n);
    expect(cost.dexFee.minor).toBe(0n);
    expect(cost.priceImpact.minor).toBe(0n);
  });
});
