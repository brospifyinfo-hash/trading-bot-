import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { eur, money } from "@sae/core";
import { computePnl, type TradeLeg } from "../pnl";

const T = (min: number) => new Date(Date.UTC(2026, 7, 30, 12, min));

const buy = (amountRaw: bigint, notionalEur: number, costsEur = 0): TradeLeg => ({
  side: "buy",
  amountRaw,
  notional: eur(notionalEur),
  costs: eur(costsEur),
  at: T(0),
});

const sell = (amountRaw: bigint, notionalEur: number, costsEur = 0, min = 10): TradeLeg => ({
  side: "sell",
  amountRaw,
  notional: eur(notionalEur),
  costs: eur(costsEur),
  at: T(min),
});

describe("computePnl", () => {
  it("rechnet eine vollstaendig geschlossene Gewinnposition", () => {
    const r = computePnl([buy(1_000n, 100, 1), sell(1_000n, 137.42, 1.31)], {
      currency: "EUR",
      currentValueOfRemaining: null,
    });
    expect(r.isClosed).toBe(true);
    expect(r.remainingRaw).toBe(0n);
    expect(r.grossRealized.minor).toBe(3_742n); // 137.42 - 100.00
    expect(r.costsPaid.minor).toBe(231n);
    expect(r.netRealized.minor).toBe(3_511n); // +35.11 €
    expect(r.netTotal?.minor).toBe(3_511n);
  });

  it("verteilt die Kostenbasis anteilig ueber Teilverkaeufe", () => {
    const r = computePnl([buy(1_000n, 100), sell(200n, 25)], {
      currency: "EUR",
      currentValueOfRemaining: eur(100),
    });
    expect(r.costBasisOfSold.minor).toBe(2_000n); // 20 % von 100 €
    expect(r.grossRealized.minor).toBe(500n); // 25 € Erloes - 20 € Basis
    expect(r.remainingRaw).toBe(800n);
    expect(r.unrealized?.minor).toBe(2_000n); // 100 € Wert - 80 € Restbasis
    expect(r.netTotal?.minor).toBe(2_500n);
  });

  it("laesst den unrealisierten Teil offen, wenn kein Preis bekannt ist", () => {
    // Ohne aktuellen Preis wird kein Gesamtergebnis behauptet.
    const r = computePnl([buy(1_000n, 100), sell(200n, 25)], {
      currency: "EUR",
      currentValueOfRemaining: null,
    });
    expect(r.unrealized).toBeNull();
    expect(r.netTotal).toBeNull();
    expect(r.netRealized.minor).toBe(500n);
  });

  it("ergibt ohne Preisbewegung genau die Kosten als Verlust", () => {
    const r = computePnl([buy(1_000n, 100, 2), sell(1_000n, 100, 2)], {
      currency: "EUR",
      currentValueOfRemaining: null,
    });
    expect(r.grossRealized.minor).toBe(0n);
    expect(r.netRealized.minor).toBe(-400n);
  });

  it("wirft, wenn mehr verkauft als gekauft wurde", () => {
    expect(() =>
      computePnl([buy(100n, 10), sell(200n, 20)], {
        currency: "EUR",
        currentValueOfRemaining: null,
      }),
    ).toThrow(/Mehr verkauft/);
  });

  it("wirft bei gemischten Waehrungen", () => {
    expect(() =>
      computePnl([{ ...buy(100n, 10), notional: money(1_000n, "USD") }], {
        currency: "EUR",
        currentValueOfRemaining: null,
      }),
    ).toThrow(TypeError);
  });
});

describe("Eigenschaften", () => {
  it("Teilverkaeufe summieren sich exakt zur Ausgangsposition", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 8 }),
        (portions) => {
          const total = portions.reduce((a, b) => a + b, 0);
          const legs: TradeLeg[] = [
            buy(BigInt(total), 100),
            ...portions.map((p, i) => sell(BigInt(p), (p / total) * 100, 0, i + 1)),
          ];
          const r = computePnl(legs, { currency: "EUR", currentValueOfRemaining: null });
          expect(r.remainingRaw).toBe(0n);
          expect(r.isClosed).toBe(true);
        },
      ),
    );
  });

  it("Kostenbasis des Verkauften uebersteigt nie das investierte Kapital", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (bought, soldPct) => {
          const sold = Math.floor((bought * soldPct) / 10_000);
          const legs: TradeLeg[] = [buy(BigInt(bought), 100)];
          if (sold > 0) legs.push(sell(BigInt(sold), 50));
          const r = computePnl(legs, { currency: "EUR", currentValueOfRemaining: null });
          expect(r.costBasisOfSold.minor).toBeLessThanOrEqual(r.investedNotional.minor);
        },
      ),
    );
  });

  it("Kosten verschlechtern das Nettoergebnis immer", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000 }), (costCents) => {
        const withCosts = computePnl(
          [buy(1_000n, 100, costCents / 100), sell(1_000n, 120)],
          { currency: "EUR", currentValueOfRemaining: null },
        );
        const withoutCosts = computePnl([buy(1_000n, 100), sell(1_000n, 120)], {
          currency: "EUR",
          currentValueOfRemaining: null,
        });
        expect(withCosts.netRealized.minor).toBeLessThanOrEqual(withoutCosts.netRealized.minor);
      }),
    );
  });
});
