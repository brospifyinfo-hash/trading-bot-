import { describe, expect, it } from "vitest";
import { tokenId } from "@sae/core";
import type { BacktestDataSource } from "@sae/backtest";
import type { PositionMarketState } from "@sae/trading";

import {
  LookAheadError,
  MIN_COUNTERFACTUALS_FOR_VERDICT,
  guardedSource,
  runCounterfactualExit,
  summarizeCounterfactuals,
  type CounterfactualPosition,
  type CounterfactualResult,
  type CounterfactualRule,
} from "../counterfactuals";

const TOKEN = tokenId("token-1");
const OPENED = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));
const CLOSED = new Date(OPENED.getTime() + 60 * 60_000);

/** Kurs steigt bis Minute 20 auf +150 %, faellt dann auf +10 %. */
function ratioAt(minutes: number): number {
  return minutes <= 20 ? 1 + minutes * 0.075 : Math.max(1.1, 2.5 - (minutes - 20) * 0.035);
}

function marketAt(minutes: number, highWater: number): PositionMarketState {
  return {
    priceRatio: ratioAt(minutes),
    highWaterRatio: highWater,
    volumeAcceleration: 1.2,
    buyRatio: 0.55,
    liquidityRatio: 1,
    smartMoneySellers: 0,
    devSold: false,
    securityDowngraded: false,
    holdingSeconds: minutes * 60,
  };
}

const source: BacktestDataSource = {
  universeAt: async () => [TOKEN],
  featuresAt: async () => null,
  positionMarketAt: async (_t, _p, _l, highWater, holdingSeconds) =>
    marketAt(holdingSeconds / 60, highWater),
  quoteAt: async () => null,
};

const position: CounterfactualPosition = {
  positionId: "pos-1",
  tokenId: TOKEN,
  entryPriceUsd: 100,
  entryLiquidityUsd: 50_000,
  openedAt: OPENED,
  closedAt: CLOSED,
  // Tatsaechlich bei +20 % ausgestiegen.
  actualNetReturn: 0.2,
};

/** Steigt aus, sobald 30 % vom Hoch abgegeben wurden. */
const trailing: CounterfactualRule = {
  id: "trailing-30",
  shouldExit: (s) => s.priceRatio <= s.highWaterRatio * 0.7,
};

describe("Look-Ahead-Schranke", () => {
  it("wirft, wenn Daten jenseits der Simulationszeit angefordert werden", async () => {
    const guard = guardedSource(source);
    guard.setClock(new Date(OPENED.getTime() + 10 * 60_000));

    // Genau der Fall aus I-4: „bei +180 % verkaufen" ist keine Regel, sondern
    // eine Beobachtung im Rueckblick.
    await expect(
      guard.source.positionMarketAt(TOKEN, 100, 50_000, 1, 0, CLOSED),
    ).rejects.toThrow(LookAheadError);
  });

  it("laesst Anfragen bis zur Simulationszeit durch", async () => {
    const guard = guardedSource(source);
    const now = new Date(OPENED.getTime() + 10 * 60_000);
    guard.setClock(now);
    await expect(
      guard.source.positionMarketAt(TOKEN, 100, 50_000, 1, 600, now),
    ).resolves.not.toBeNull();
  });

  it("merkt sich den spaetesten angefragten Zeitpunkt", async () => {
    const guard = guardedSource(source);
    const t = new Date(OPENED.getTime() + 5 * 60_000);
    guard.setClock(t);
    await guard.source.universeAt(t);
    expect(guard.maxRequested()!.getTime()).toBe(t.getTime());
  });
});

describe("Gegenentwurf zum Ausstieg", () => {
  it("fragt die Regel Schritt fuer Schritt und nie in die Zukunft", async () => {
    const result = await runCounterfactualExit({ position, rule: trailing, source });

    expect(result.exitAt).not.toBeNull();
    expect(result.maxAsOfRequested!.getTime()).toBeLessThanOrEqual(result.exitAt!.getTime());
    expect(result.stepsEvaluated).toBeGreaterThan(0);
  });

  it("findet einen besseren Ausstieg, wenn es ihn zum Zeitpunkt gab", async () => {
    const result = await runCounterfactualExit({ position, rule: trailing, source });

    // Hoch bei +150 %, 30 % darunter sind rund +75 % — deutlich besser als die
    // tatsaechlichen +20 %, und die Regel haette es zum Zeitpunkt sehen koennen.
    expect(result.counterfactualReturn!).toBeGreaterThan(0.5);
    expect(result.delta!).toBeGreaterThan(0);
    expect(result.note).toMatch(/Kosten sind noch abzuziehen/);
  });

  it("bewertet eine nicht ausloesende Regel am tatsaechlichen Schluss", async () => {
    // Und ausdruecklich nicht am spaeteren Hoch.
    const never: CounterfactualRule = { id: "nie", shouldExit: () => false };
    const result = await runCounterfactualExit({ position, rule: never, source });

    expect(result.exitAt).toBeNull();
    expect(result.counterfactualReturn).toBeNull();
    expect(result.delta).toBeNull();
    expect(result.note).toMatch(/tatsaechliche Schluss/);
  });

  it("meldet einen fehlenden Kursverlauf, statt etwas anzunehmen", async () => {
    const blind: BacktestDataSource = { ...source, positionMarketAt: async () => null };
    const result = await runCounterfactualExit({ position, rule: trailing, source: blind });
    expect(result.counterfactualReturn).toBeNull();
    expect(result.stepsEvaluated).toBeGreaterThan(0);
  });
});

describe("Zusammenfassung", () => {
  function result(delta: number): CounterfactualResult {
    return {
      positionId: "p",
      ruleId: "r",
      exitAt: CLOSED,
      counterfactualReturn: 0.2 + delta,
      actualNetReturn: 0.2,
      delta,
      stepsEvaluated: 10,
      maxAsOfRequested: CLOSED,
      note: "",
    };
  }

  it("urteilt nicht bei zu wenigen Faellen", () => {
    const summary = summarizeCounterfactuals("r", [result(0.5), result(0.4)]);
    expect(summary.verdict).toBe("TOO_LITTLE_DATA");
    expect(MIN_COUNTERFACTUALS_FOR_VERDICT).toBeGreaterThan(10);
  });

  it("laesst einen einzelnen Ausreisser die Alternative nicht besser machen", () => {
    // 59 leicht schlechtere Faelle und ein Verzehnfacher: der Mittelwert waere
    // klar positiv, der Median ist es nicht — und genau diesen einen Fall
    // findet man im Rueckblick immer.
    const results = [
      ...Array.from({ length: 59 }, () => result(-0.05)),
      result(9.0),
    ];
    const summary = summarizeCounterfactuals("r", results);

    expect(summary.medianDelta!).toBeLessThan(0);
    expect(summary.verdict).toBe("WORSE");
  });

  it("nennt eine Alternative nur bei einer Mehrheit besser", () => {
    const results = [
      ...Array.from({ length: 35 }, () => result(0.1)),
      ...Array.from({ length: 30 }, () => result(-0.1)),
    ];
    const summary = summarizeCounterfactuals("r", results);
    // 54 % besser — knapp, aber keine Mehrheit im Sinne der Schwelle.
    expect(summary.verdict).toBe("NO_DIFFERENCE");
  });

  it("erkennt eine deutlich bessere Alternative", () => {
    const results = [
      ...Array.from({ length: 60 }, () => result(0.15)),
      ...Array.from({ length: 10 }, () => result(-0.05)),
    ];
    expect(summarizeCounterfactuals("r", results).verdict).toBe("BETTER");
  });
});
