import { describe, expect, it } from "vitest";
import { eur } from "@sae/core";
import {
  MIN_SAMPLE_FOR_VERDICT,
  computeTradeStatistics,
} from "../trade-statistics";
import { trade, tradesWithWinRate } from "./fixtures";

describe("computeTradeStatistics", () => {
  it("liefert bei leerer Eingabe keine erfundenen Kennzahlen", () => {
    const stats = computeTradeStatistics([], "EUR");
    expect(stats.totalTrades).toBe(0);
    // Null Trades ergeben keine Trefferquote — nicht 0 % und nicht 50 %.
    expect(stats.winRate).toBeNull();
    expect(stats.profitFactor).toBeNull();
    expect(stats.sufficientSample).toBe(false);
  });

  it("zaehlt Gewinner und Verlierer", () => {
    const stats = computeTradeStatistics([trade(30), trade(-10), trade(20), trade(-5)], "EUR");
    expect(stats.totalTrades).toBe(4);
    expect(stats.winningTrades).toBe(2);
    expect(stats.losingTrades).toBe(2);
    expect(stats.winRate).toBe(0.5);
  });

  it("rechnet den Profit Factor aus Brutto-Gewinnen und -Verlusten", () => {
    const stats = computeTradeStatistics([trade(30), trade(20), trade(-25)], "EUR");
    expect(stats.profitFactor).toBeCloseTo(2, 6);
  });

  it("liefert ohne Verluste keinen Profit Factor statt eines Traumwerts", () => {
    // Bei einer Stichprobe ohne einen einzigen Verlust ist die Stichprobe das
    // Problem, nicht die Strategie.
    const stats = computeTradeStatistics([trade(10), trade(20)], "EUR");
    expect(stats.profitFactor).toBeNull();
  });

  it("misst den maximalen Rueckgang der kumulierten Kurve", () => {
    // Kurve: +50, +20, -30, -40, +60 -> Hoch 70 bei Trade 2, Tief 0 bei Trade 4.
    const stats = computeTradeStatistics(
      [trade(50), trade(20), trade(-30), trade(-40), trade(60)],
      "EUR",
    );
    expect(stats.maxDrawdown).toEqual(eur(70));
  });

  it("zaehlt die laengste Serie in beide Richtungen", () => {
    const stats = computeTradeStatistics(
      [trade(10), trade(10), trade(10), trade(-5), trade(-5), trade(20)],
      "EUR",
    );
    expect(stats.maxConsecutiveWins).toBe(3);
    expect(stats.maxConsecutiveLosses).toBe(2);
  });

  it("weist die Kosten getrennt aus, ohne sie aus dem Ergebnis zu nehmen", () => {
    const stats = computeTradeStatistics([trade(10), trade(10)], "EUR");
    expect(stats.totalCosts).toEqual(eur(4));
    // netPnl ist bereits nach Kosten — die Summe wird nicht noch einmal bereinigt.
    expect(stats.totalNetPnl).toEqual(eur(20));
  });

  it("berechnet den Erwartungswert je Trade", () => {
    const stats = computeTradeStatistics([trade(30), trade(-10)], "EUR");
    expect(stats.expectedValuePerTrade).toEqual(eur(10));
  });

  it("nennt besten und schlechtesten Trade", () => {
    const stats = computeTradeStatistics([trade(5), trade(-40), trade(70)], "EUR");
    expect(stats.bestTrade).toEqual(eur(70));
    expect(stats.worstTrade).toEqual(eur(-40));
  });

  it("markiert eine zu kleine Stichprobe als solche", () => {
    // Eine Win Rate aus neun Trades ist Rauschen — und die Zahl allein sieht
    // nicht danach aus. Deshalb steht es im Ergebnis.
    const small = computeTradeStatistics(tradesWithWinRate(9, 0.9), "EUR");
    expect(small.winRate).toBeCloseTo(0.89, 1);
    expect(small.sufficientSample).toBe(false);

    const large = computeTradeStatistics(tradesWithWinRate(MIN_SAMPLE_FOR_VERDICT, 0.6), "EUR");
    expect(large.sufficientSample).toBe(true);
  });

  it("wertet unabhaengig von der Eingabereihenfolge", () => {
    const trades = [trade(50), trade(-30), trade(20)];
    const a = computeTradeStatistics(trades, "EUR");
    const b = computeTradeStatistics([...trades].reverse(), "EUR");
    expect(a.totalNetPnl).toEqual(b.totalNetPnl);
    expect(a.maxDrawdown).toEqual(b.maxDrawdown);
  });

  it("lehnt Trades in fremder Waehrung ab", () => {
    expect(() =>
      computeTradeStatistics([trade(10, { netPnl: { minor: 1_000n, currency: "USD" } })], "EUR"),
    ).toThrow(TypeError);
  });

  it("misst die durchschnittliche Haltedauer", () => {
    const stats = computeTradeStatistics([trade(10), trade(-5)], "EUR");
    expect(stats.averageHoldingSeconds).toBe(1_800);
  });
});
