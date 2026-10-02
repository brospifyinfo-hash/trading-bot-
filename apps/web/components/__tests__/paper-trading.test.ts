import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";
import { eur } from "@sae/core";
import { PaperTrading, paperMoney } from "../PaperTrading";

vi.mock("../PaperRefresh", () => ({ PaperRefresh: () => null }));
vi.mock("../SellButton", () => ({ SellButton: ({ angefordertAm }: { angefordertAm: Date | null }) => React.createElement("span", null, angefordertAm === null ? "verkaufen" : "angefordert") }));
vi.mock("../CopyButton", () => ({ CopyButton: () => null }));
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
      initialCash: eur(3000), open: [], closed: [], closedCount: 0, live: new Map(),
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

/**
 * Der aktuelle Stand einer offenen Position.
 *
 * Die Frage, die man bei einer offenen Position hat, ist „Plus oder Minus" —
 * und genau die konnte das Dashboard nicht beantworten. Jetzt schon, aber nur
 * wenn beide Kurse vorliegen.
 */
const position = (over: Record<string, unknown> = {}) => ({
  position: {
    id: "11111111-1111-4111-8111-111111111111",
    tokenId: "t1", openedAt: new Date("2026-10-02T10:00:00Z"), closedAt: null,
    entryNotionalMinor: 2_500n, entryAmountRaw: 1_000n, remainingAmountRaw: 1_000n,
    costsPaidMinor: 30n, realizedPnlMinor: 0n, exitReason: null,
    closeRequestedAt: null, version: 0,
    ...over,
  },
  token: { mint: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", symbol: "MEME", name: null },
  version: "2.0.0-s10-offensiv",
});

/*
 * Eine Attrappe des Lesezustands.
 *
 * Bewusst ueber `as never` an die Komponente gegeben: der echte Typ kommt aus
 * einer Datenbankabfrage mit zwei Dutzend Spalten, und die hier nachzubauen
 * wuerde den Test an jede Spaltenaenderung binden, ohne dass er mehr pruefen
 * wuerde. Geprueft wird die DARSTELLUNG, und dafuer zaehlen die Felder, die
 * sie liest.
 */
const konto = (over: Record<string, unknown>): never => ({
  kind: "READY" as const, updatedAt: new Date("2026-10-02T10:05:00Z"),
  initialCash: eur(3000),
  account: { kind: "READY", cash: eur(2970), bookValue: eur(2995),
    portfolio: { value: eur(2995), openPositions: [], realizedTodayPnl: eur(0), consecutiveLosses: 0 },
    closedReturns: [] },
  closed: [], closedCount: 0, ...over,
}) as never;

it("zeigt den unrealisierten Stand mit Kursalter", () => {
  const html = renderToStaticMarkup(React.createElement(PaperTrading, {
    data: konto({
      open: [position()],
      live: new Map([["11111111-1111-4111-8111-111111111111", {
        positionId: "11111111-1111-4111-8111-111111111111", kind: "MEASURED" as const,
        einstandRestMinor: 2_500n, wertJetztMinor: 3_000n, unrealisiertMinor: 500n,
        verhaeltnis: 1.2, kursObservedAt: new Date("2026-10-02T10:04:30Z"), kursAlterSekunden: 30,
      }]]),
    }),
  }));
  expect(html).toContain("+5,00 EUR");
  expect(html).toContain("+20 %");
  // Das Alter gehoert dazu: ein Stand von vor einer halben Stunde ist bei
  // Memecoins keine Auskunft ueber das Jetzt.
  expect(html).toContain("30 s alt");
});

it("schreibt nicht-messbar statt einer Null, wenn ein Kurs fehlt", () => {
  const html = renderToStaticMarkup(React.createElement(PaperTrading, {
    data: konto({
      open: [position()],
      live: new Map([["11111111-1111-4111-8111-111111111111", {
        positionId: "11111111-1111-4111-8111-111111111111", kind: "UNKNOWN" as const,
        reason: "KEIN_AKTUELLER_KURS" as const, einstandRestMinor: 2_500n,
      }]]),
    }),
  }));
  expect(html).toContain("kein aktueller Kurs");
  // Eine 0 hier hiesse „kein Gewinn" und waere eine andere Aussage als
  // „nicht messbar". Der gemessene Zweig schreibt „Wert …" — er darf hier
  // nicht erscheinen.
  expect(html).not.toContain("Wert ");
  expect(html).not.toContain("Kurs 0 s alt");
});

it("zeigt eine angeforderte Schliessung als angefordert", () => {
  const html = renderToStaticMarkup(React.createElement(PaperTrading, {
    data: konto({
      open: [position({ closeRequestedAt: new Date("2026-10-02T10:04:00Z") })],
      live: new Map(),
    }),
  }));
  // Der Knopf behauptet keinen abgeschlossenen Verkauf.
  expect(html).toContain("angefordert");
});
