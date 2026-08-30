import { describe, expect, it } from "vitest";
import { compareFactor, splitByThreshold, wilsonInterval } from "../factor-analysis";
import { trade, tradesWithWinRate } from "./fixtures";
import type { ClosedTrade } from "../trade-statistics";

describe("wilsonInterval", () => {
  it("liefert bei drei von drei kein Intervall bis 100 Prozent Untergrenze", () => {
    const { lower, upper } = wilsonInterval(3, 3);
    expect(lower).toBeLessThan(0.5);
    expect(upper).toBeCloseTo(1, 1);
  });

  it("wird mit wachsender Stichprobe enger", () => {
    const small = wilsonInterval(6, 10);
    const large = wilsonInterval(600, 1_000);
    expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
  });
});

describe("compareFactor", () => {
  it("gibt kein Urteil ab, wenn ein Bucket zu klein ist", () => {
    // Auch dann nicht, wenn er gut aussieht.
    const result = compareFactor(
      "smartMoney",
      [
        { label: "> 80", trades: tradesWithWinRate(12, 0.92) },
        { label: "< 50", trades: tradesWithWinRate(400, 0.4) },
      ],
      "EUR",
    );
    expect(result.separation).toBeNull();
    expect(result.note).toContain("Kein Urteil");
    expect(result.buckets[0]!.verdict).toBe("TOO_LITTLE_DATA");
  });

  it("erkennt einen Unterschied, wenn sich die Intervalle nicht ueberlappen", () => {
    const result = compareFactor(
      "liquidity",
      [
        { label: "> 100k", trades: tradesWithWinRate(500, 0.62) },
        { label: "< 20k", trades: tradesWithWinRate(500, 0.3) },
      ],
      "EUR",
    );
    expect(result.separation).not.toBeNull();
    expect(result.separation!.better).toBe("> 100k");
    expect(result.separation!.winRateGap).toBeGreaterThan(0.25);
  });

  it("meldet keinen Unterschied, wenn sich die Intervalle ueberlappen", () => {
    // Ein Unterschied, dessen Intervalle sich ueberschneiden, ist kein
    // beobachteter Unterschied — egal wie verlockend die Punktschaetzung aussieht.
    const result = compareFactor(
      "social",
      [
        { label: "> 80", trades: tradesWithWinRate(120, 0.55) },
        { label: "< 50", trades: tradesWithWinRate(120, 0.5) },
      ],
      "EUR",
    );
    expect(result.separation).toBeNull();
    expect(result.note).toContain("ueberlappen");
  });

  it("behauptet keine Kausalitaet", () => {
    const result = compareFactor(
      "liquidity",
      [
        { label: "hoch", trades: tradesWithWinRate(500, 0.7) },
        { label: "niedrig", trades: tradesWithWinRate(500, 0.2) },
      ],
      "EUR",
    );
    expect(result.note).toContain("kein Kausalitaetsnachweis");
  });

  it("verlangt mindestens zwei Auspraegungen", () => {
    const result = compareFactor(
      "momentum",
      [{ label: "nur eine", trades: tradesWithWinRate(300, 0.6) }],
      "EUR",
    );
    expect(result.separation).toBeNull();
    expect(result.note).toContain("mindestens zwei");
  });
});

describe("splitByThreshold", () => {
  interface Scored extends ClosedTrade {
    readonly score: number | null;
  }
  const scored = (pnl: number, score: number | null): Scored => ({ ...trade(pnl), score });

  it("teilt am Schwellwert", () => {
    const buckets = splitByThreshold(
      [scored(10, 90), scored(-5, 40), scored(20, 80)],
      (t) => t.score,
      75,
      { above: "hoch", below: "niedrig" },
    );
    expect(buckets[0]!.trades).toHaveLength(2);
    expect(buckets[1]!.trades).toHaveLength(1);
  });

  it("schliesst Trades ohne Merkmalswert aus beiden Buckets aus", () => {
    // Sie einer Seite zuzuschlagen waere genau die stille Verzerrung, die eine
    // Faktoranalyse wertlos macht.
    const buckets = splitByThreshold(
      [scored(10, 90), scored(-5, null), scored(20, 40)],
      (t) => t.score,
      75,
      { above: "hoch", below: "niedrig" },
    );
    const total = buckets.reduce((sum, b) => sum + b.trades.length, 0);
    expect(total).toBe(2);
  });
});
