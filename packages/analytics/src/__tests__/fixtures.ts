import { eur } from "@sae/core";
import type { ClosedTrade } from "../trade-statistics";

let counter = 0;

export function trade(netPnlEur: number, overrides: Partial<ClosedTrade> = {}): ClosedTrade {
  counter += 1;
  const openedAt = new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + counter * 3_600_000);
  return {
    tradeId: `t-${counter}`,
    tokenId: `token-${counter}`,
    mode: "paper",
    openedAt,
    closedAt: new Date(openedAt.getTime() + 1_800_000),
    investedNotional: eur(100),
    netPnl: eur(netPnlEur),
    costsPaid: eur(2),
    realizedSlippageBps: 40,
    strategyVersionId: "sv-1",
    scoreEngineVersion: "1.0.0",
    exitReason: "TP",
    ...overrides,
  };
}

/** n Trades mit fester Trefferquote — fuer Stichprobengroessen-Tests. */
export function tradesWithWinRate(count: number, winRate: number): ClosedTrade[] {
  const winners = Math.round(count * winRate);
  return [
    ...Array.from({ length: winners }, () => trade(20)),
    ...Array.from({ length: count - winners }, () => trade(-10)),
  ];
}
