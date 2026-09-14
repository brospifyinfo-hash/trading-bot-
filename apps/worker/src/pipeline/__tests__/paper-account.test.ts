import { describe, expect, it } from "vitest";
import { eur } from "@sae/core";
import { reconcilePaperAccount } from "../paper-account";

const at = new Date("2026-09-14T12:00:00Z");
const openedAt = new Date("2026-09-13T12:00:00Z");
const position = {
  id: "p", tokenId: "token", strategyVersionId: "v1", currency: "EUR" as const,
  entryNotionalMinor: 10_001n, entryAmountRaw: 3n, remainingAmountRaw: 2n,
  realizedPnlMinor: 1_667n, costsPaidMinor: 120n, openedAt, closedAt: null,
};
const events = [
  { positionId: "p", kind: "OPENED", at: openedAt,
    detail: { entryNotionalMinor: "10001", currency: "EUR", entryCostsMinor: "100" } },
  { positionId: "p", kind: "PARTIAL_TP", at,
    detail: { soldAmountRaw: "1", proceedsMinor: "5000", costBasisMinor: "3333", costsMinor: "20", currency: "EUR" } },
];
const input = { initialCash: eur(3_000), asOf: at, positions: [position], events };

describe("reconciled paper account", () => {
  it("returns only actual sale proceeds to cash and keeps the unsold cost basis committed", () => {
    const account = reconcilePaperAccount(input);
    expect(account.kind).toBe("READY");
    if (account.kind !== "READY") return;
    // 3000 - 100.01 - 1 + 50 - .20, no unrealized price gains.
    expect(account.cash).toEqual(eur(2948.79));
    expect(account.bookValue).toEqual(eur(3015.47));
    expect(account.portfolio.value).toEqual(account.cash);
    expect(account.portfolio.openPositions).toEqual([{ tokenId: "token", notional: eur(66.68) }]);
    expect(account.portfolio.realizedTodayPnl).toEqual(eur(16.47));
    expect(account.closedReturns).toEqual([]);
  });
  it("conserves the last cent across all partials and deducts costs once", () => {
    const account = reconcilePaperAccount({ ...input,
      positions: [{ ...position, remainingAmountRaw: 0n, realizedPnlMinor: 1_999n, costsPaidMinor: 160n, closedAt: at }],
      events: [...events,
        { positionId: "p", kind: "PARTIAL_TP", at,
          detail: { soldAmountRaw: "1", proceedsMinor: "4000", costBasisMinor: "3334", costsMinor: "20", currency: "EUR" } },
        { positionId: "p", kind: "EXIT_FILL", at,
          detail: { soldAmountRaw: "1", proceedsMinor: "3000", costBasisMinor: "3334", costsMinor: "20", currency: "EUR" } },
      ],
    });
    expect(account.kind).toBe("READY");
    if (account.kind !== "READY") return;
    expect(account.cash).toEqual(eur(3018.39));
    expect(account.bookValue).toEqual(account.cash);
    expect(account.portfolio.openPositions).toEqual([]);
    expect(account.portfolio.realizedTodayPnl).toEqual(eur(19.39));
    expect(account.closedReturns[0]?.netReturn).toBeCloseTo(1839 / 10001, 8);
  });
  it("accounts for entry fees today and reconstructs older documented entry costs", () => {
    const account = reconcilePaperAccount({ ...input, positions: [{ ...position, openedAt: at }],
      events: [{ ...events[0]!, at, detail: { entryNotionalMinor: "10001", currency: "EUR" } }, events[1]!],
    });
    expect(account.kind).toBe("READY");
    if (account.kind === "READY") expect(account.portfolio.realizedTodayPnl).toEqual(eur(15.47));
  });
  it("blocks missing, contradictory, foreign-currency and future accounting", () => {
    for (const altered of [
      { ...input, events: [events[0]!] },
      { ...input, positions: [{ ...position, realizedPnlMinor: 0n }] },
      { ...input, positions: [{ ...position, costsPaidMinor: 0n }] },
      { ...input, positions: [{ ...position, currency: "USD" as const }] },
      { ...input, positions: [{ ...position, closedAt: at }] },
      { ...input, asOf: openedAt },
      { ...input, events: [...events, { ...events[1]!, positionId: "unknown" }] },
      { ...input, positions: [position, position] },
      { ...input, events: [...events, { ...events[1]!, kind: "LEGACY_FILL" }] },
    ]) expect(reconcilePaperAccount(altered).kind).toBe("BLOCKED");
  });
  it("does not reset losses or overdrafts to the initial bankroll", () => {
    const account = reconcilePaperAccount({ initialCash: eur(1), asOf: at,
      positions: [{ ...position, remainingAmountRaw: 0n, realizedPnlMinor: -10_001n, costsPaidMinor: 120n, closedAt: at }],
      events: [events[0]!, { positionId: "p", kind: "EXIT_FILL", at,
        detail: { soldAmountRaw: "3", proceedsMinor: "0", costBasisMinor: "10001", costsMinor: "20", currency: "EUR" } }],
    });
    expect(account.kind).toBe("READY");
    if (account.kind !== "READY") return;
    expect(account.cash.minor).toBe(-10_021n);
    expect(account.portfolio.value.minor).toBe(0n);
    expect(account.portfolio.consecutiveLosses).toBe(1);
  });
});
