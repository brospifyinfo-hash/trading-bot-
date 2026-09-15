import { describe, expect, it } from "vitest";
import { eur, usd } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { sizeCostAwarePaper } from "../cost-aware-sizing";

const base = {
  portfolioValue: eur(3_000), stopDistance: 0.2, evConfidence: 0,
  maxNotionalByLiquidity: eur(200), remainingExposure: eur(300),
  roundTripCosts: eur(0.30), maxRoundTripCostBps: MEMECOIN_PAPER_CANDIDATE.maxRoundTripCostBps,
  parameters: MEMECOIN_PAPER_CANDIDATE.parameters,
};

describe("cost-aware paper candidate", () => {
  it("sizes down with low confidence without a fixed 100 EUR minimum", () => {
    const low = sizeCostAwarePaper(base);
    const high = sizeCostAwarePaper({ ...base, evConfidence: 1 });
    expect(low.kind).toBe("SIZED");
    expect(low.sizing?.size).toEqual(eur(18.75));
    expect(high.sizing?.size).toEqual(eur(75));
  });
  it("does not enlarge an order to make its costs affordable", () => {
    expect(sizeCostAwarePaper({ ...base, roundTripCosts: eur(1) }).kind).toBe("BLOCKED");
    expect(sizeCostAwarePaper({ ...base, roundTripCosts: eur(0.38) }).kind).toBe("BLOCKED");
    expect(sizeCostAwarePaper({ ...base, roundTripCosts: eur(0.37) }).kind).toBe("SIZED");
  });
  it("reserves costs within remaining exposure and honors exit capacity", () => {
    expect(sizeCostAwarePaper({ ...base, remainingExposure: eur(16) }).sizing?.size).toEqual(eur(15.70));
    expect(sizeCostAwarePaper({ ...base, maxNotionalByLiquidity: eur(10) }).kind).toBe("BLOCKED");
  });
  it("does not replace missing measurements or mix currencies", () => {
    expect(sizeCostAwarePaper({ ...base, roundTripCosts: null }).kind).toBe("BLOCKED");
    expect(sizeCostAwarePaper({ ...base, remainingExposure: null }).kind).toBe("BLOCKED");
    expect(sizeCostAwarePaper({ ...base, maxNotionalByLiquidity: null }).kind).toBe("BLOCKED");
    expect(() => sizeCostAwarePaper({ ...base, roundTripCosts: usd(0.3) })).toThrow();
    expect(() => sizeCostAwarePaper({ ...base, maxRoundTripCostBps: 0 })).toThrow();
  });
});
