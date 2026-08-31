import { describe, expect, it } from "vitest";
import type { Bps } from "@sae/core";

import {
  DEFAULT_EXIT_SCORE_BANDS,
  adviseFromExitScore,
  combineWithRules,
  computeExitScore,
} from "../exit-score";
import type { ExitSignal, PositionMarketState } from "../exit-rules";

const healthy: PositionMarketState = {
  priceRatio: 1.8,
  highWaterRatio: 1.8,
  volumeAcceleration: 1.4,
  buyRatio: 0.65,
  liquidityRatio: 1.1,
  smartMoneySellers: 0,
  devSold: false,
  securityDowngraded: false,
  holdingSeconds: 600,
};

const MAX_HOLD = 86_400;

describe("Exit Score", () => {
  it("bleibt bei intakter Position niedrig", () => {
    const result = computeExitScore(healthy, MAX_HOLD);
    expect(result.computable).toBe(true);
    expect(result.score).toBeLessThan(DEFAULT_EXIT_SCORE_BANDS.tightenAbove);
    expect(adviseFromExitScore(result)).toEqual({ kind: "HOLD" });
  });

  it("steigt, wenn vom Hoch abgegeben wird", () => {
    const givingBack = computeExitScore(
      { ...healthy, priceRatio: 1.1, highWaterRatio: 2.0 },
      MAX_HOLD,
    );
    expect(givingBack.score).toBeGreaterThan(computeExitScore(healthy, MAX_HOLD).score);
    expect(givingBack.drivers.join(" ")).toMatch(/vom Hoch abgegeben/);
  });

  it("sieht nachlassendes Volumen und abfliessende Liquiditaet getrennt", () => {
    const quiet = computeExitScore({ ...healthy, volumeAcceleration: 0.4 }, MAX_HOLD);
    const draining = computeExitScore({ ...healthy, liquidityRatio: 0.3 }, MAX_HOLD);

    expect(quiet.perDimension.MOMENTUM_DECAY).toBe(100);
    expect(quiet.perDimension.LIQUIDITY_DRAIN).toBe(0);
    expect(draining.perDimension.LIQUIDITY_DRAIN).toBe(100);
    expect(draining.perDimension.MOMENTUM_DECAY).toBe(0);
  });

  it("macht aus fehlenden Daten kein „unauffaellig“", () => {
    const blind = computeExitScore(
      {
        ...healthy,
        volumeAcceleration: null,
        buyRatio: null,
        liquidityRatio: null,
      },
      null,
    );

    expect(blind.unassessed).toEqual([
      "MOMENTUM_DECAY",
      "LIQUIDITY_DRAIN",
      "SELL_PRESSURE",
      "AGE",
    ]);
    expect(blind.perDimension.MOMENTUM_DECAY).toBeUndefined();
    expect(blind.computable).toBe(false);
  });

  it("gibt bei nicht belastbarem Score keinen Rat statt „halten“", () => {
    // „Halten" waere ebenfalls eine Entscheidung — und durch nichts gedeckt.
    const blind = computeExitScore(
      { ...healthy, volumeAcceleration: null, buyRatio: null, liquidityRatio: null },
      null,
    );
    expect(adviseFromExitScore(blind)).toEqual({ kind: "NO_ADVICE", reason: "NOT_COMPUTABLE" });
  });

  it("laesst einen einzelnen entscheidenden Befund allein tragen", () => {
    // Mit einem Mittelwert kaemen zwei voll ausgeschlagene Dimensionen von
    // fuenf auf 40 Punkte — unter jeder Schwelle. Der Score saehe die Grauzone
    // nie, fuer die es ihn gibt.
    const oneStrong = computeExitScore(
      { ...healthy, priceRatio: 1.0, highWaterRatio: 2.5 },
      MAX_HOLD,
    );
    expect(oneStrong.perDimension.GIVEBACK).toBe(100);
    expect(oneStrong.score).toBe(100);
  });

  it("laesst zwei schwache Befunde sich verstaerken", () => {
    const two = computeExitScore(
      { ...healthy, priceRatio: 1.44, highWaterRatio: 1.8, volumeAcceleration: 0.75 },
      null,
    );
    expect(two.perDimension.GIVEBACK).toBeCloseTo(50, 0);
    expect(two.perDimension.MOMENTUM_DECAY).toBeCloseTo(50, 0);
    // Zweimal 50 ergibt 75, nicht 50.
    expect(two.score).toBeCloseTo(75, 0);
  });

  it("darf allein keinen vollstaendigen Ausstieg ausloesen", () => {
    const terrible = computeExitScore(
      {
        ...healthy,
        priceRatio: 0.5,
        highWaterRatio: 3.0,
        volumeAcceleration: 0.1,
        buyRatio: 0.05,
        liquidityRatio: 0.1,
        holdingSeconds: MAX_HOLD,
      },
      MAX_HOLD,
    );

    expect(terrible.score).toBeGreaterThan(90);
    // Die schaerfste Stufe ist ein Teilverkauf. Ein vollstaendiger Ausstieg
    // braucht ein Ereignis, das eine der harten Regeln sieht.
    expect(adviseFromExitScore(terrible)).toEqual({ kind: "PARTIAL_EXIT" });
  });
});

describe("Zusammenspiel mit den harten Regeln", () => {
  const ruleSignal: ExitSignal = {
    ruleId: "DEV_SOLD",
    action: { kind: "EXIT_ALL", urgency: "IMMEDIATE" },
    detail: "Entwickler hat verkauft",
  };

  it("laesst eine feuernde Regel nicht vom Score abschwaechen", () => {
    const calm = computeExitScore(healthy, MAX_HOLD);
    const combined = combineWithRules({
      ruleSignals: [ruleSignal],
      advice: adviseFromExitScore(calm),
    });

    expect(combined.source).toBe("RULE");
    expect(combined.signals).toEqual([ruleSignal]);
    expect(combined.advice).toBeNull();
  });

  it("kommt nur zum Zug, wenn keine Regel etwas sagt", () => {
    const decaying = computeExitScore(
      { ...healthy, priceRatio: 1.2, highWaterRatio: 2.4, volumeAcceleration: 0.4 },
      MAX_HOLD,
    );
    const combined = combineWithRules({
      ruleSignals: [],
      advice: adviseFromExitScore(decaying),
    });

    expect(combined.source).toBe("SCORE");
    expect(combined.advice?.kind).toMatch(/TIGHTEN|PARTIAL_EXIT/);
  });

  it("bleibt still, wenn weder Regel noch Score etwas sagen", () => {
    const combined = combineWithRules({
      ruleSignals: [],
      advice: adviseFromExitScore(computeExitScore(healthy, MAX_HOLD)),
    });
    expect(combined.source).toBe("NONE");
  });
});

describe("Trennung vom Einstiegsscore", () => {
  it("bewertet Halten und Kaufen als verschiedene Fragen", () => {
    // Derselbe Token, zwei Stunden spaeter: der Einstiegsscore kennt den
    // Verlauf seither nicht, der Exit Score besteht aus ihm.
    const asBps = (n: number): Bps => n as Bps;
    expect(asBps(1_500)).toBe(1_500);

    const atEntry = computeExitScore(
      { ...healthy, priceRatio: 1.0, highWaterRatio: 1.0, holdingSeconds: 0 },
      MAX_HOLD,
    );
    const later = computeExitScore(
      { ...healthy, priceRatio: 1.05, highWaterRatio: 2.2, holdingSeconds: 7_200 },
      MAX_HOLD,
    );

    expect(later.score).toBeGreaterThan(atEntry.score);
  });
});
