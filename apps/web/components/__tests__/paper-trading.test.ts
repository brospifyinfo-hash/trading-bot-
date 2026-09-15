import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";
import { eur } from "@sae/core";
import { PaperTrading, paperMoney } from "../PaperTrading";

vi.mock("../PaperRefresh", () => ({ PaperRefresh: () => null }));
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

it("shows unknown balances without inventing zero or initial cash", () => {
  const html = renderToStaticMarkup(React.createElement(PaperTrading, {
    data: { kind: "BLOCKED", updatedAt: new Date("2026-09-15T00:00:00Z") },
  }));
  expect(html).toContain("derzeit unbekannt");
  expect(html).not.toContain("3.000,00");
});

it("renders a reconciled empty account and explicitly labels virtual capital", () => {
  const html = renderToStaticMarkup(React.createElement(PaperTrading, {
    data: { kind: "READY", updatedAt: new Date("2026-09-15T00:00:00Z"),
      initialCash: eur(3000), open: [], closed: [], closedCount: 0,
      account: { kind: "READY", cash: eur(2999), bookValue: eur(2999),
        portfolio: { value: eur(2999), openPositions: [], realizedTodayPnl: eur(-1), consecutiveLosses: 0 },
        closedReturns: [] } },
  }));
  expect(html).toContain("2.999,00 EUR");
  expect(html).toContain("−1,00 EUR");
  expect(html).toContain("Virtuelles Startkapital");
  expect(html).toContain("Noch keine abgeschlossenen Trades");
  expect(html).toContain("Noch keine offenen Positionen");
});

it("formats large monetary amounts without floating point rounding", () => {
  expect(paperMoney(-900719925474099199n)).toBe("−9.007.199.254.740.991,99 EUR");
});
