import { describe, expect, it } from "vitest";
import { bps } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { evaluatePosition, type PositionState } from "../position-manager";
import type { PositionMarketState } from "../exit-rules";

const exit = MEMECOIN_PAPER_CANDIDATE.parameters.exit;
const position: PositionState = {
  positionId: "candidate-fixture", remainingBps: bps(10_000),
  stopLossBps: bps(exit.stopLossBps), trailingStopBps: bps(exit.trailingStopBps!),
  maxHoldingSeconds: exit.maxHoldingTimeSeconds,
  takeProfits: exit.takeProfits.map((tp) => ({ ...tp, triggerGainBps: bps(tp.triggerGainBps), sellPortionBps: bps(tp.sellPortionBps), hit: false })),
};
const market: PositionMarketState = {
  priceRatio: 1, highWaterRatio: 1, volumeAcceleration: null, buyRatio: null,
  liquidityRatio: null, smartMoneySellers: null, devSold: null,
  securityDowngraded: false, holdingSeconds: 0,
};

describe("candidate exit mechanics, not performance evidence", () => {
  it("takes 40% at +25% and leaves 10% after the entire ladder", () => {
    expect(evaluatePosition(position, { ...market, priceRatio: 1.25, highWaterRatio: 1.25 }).actions)
      .toEqual([{ kind: "SELL_PORTION", portionBps: 4_000, levelIndex: 1 }]);
    const actions = evaluatePosition(position, { ...market, priceRatio: 2, highWaterRatio: 2 }).actions;
    expect(actions.reduce((sum, action) => sum + (action.kind === "SELL_PORTION" ? action.portionBps : 0), 0)).toBe(9_000);
  });
  it("exits at loss, retracement, and timeout instead of waiting for higher targets", () => {
    for (const sample of [
      { ...market, priceRatio: 0.8 },
      { ...market, highWaterRatio: 2, priceRatio: 1.69 },
      { ...market, holdingSeconds: 21_600 },
    ]) expect(evaluatePosition(position, sample).actions).toEqual([{ kind: "EXIT_ALL", urgency: "NORMAL" }]);
  });
});
