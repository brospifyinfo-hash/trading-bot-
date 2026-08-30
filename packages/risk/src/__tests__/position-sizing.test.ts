import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { eur } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { computePositionSize, confidenceFactor } from "../position-sizing";

const base = {
  portfolioValue: eur(1_000),
  stopDistance: 0.2,
  maxNotionalByLiquidity: eur(500),
  evConfidence: 1,
  minimumNotional: eur(5),
  parameters: DEFAULT_STRATEGY_PARAMETERS,
};

describe("computePositionSize", () => {
  it("nimmt das Risikobudget geteilt durch den Stopabstand", () => {
    // 1 % von 1000 EUR = 10 EUR Risiko; bei 20 % Stop sind das 50 EUR Position.
    // Gedeckelt durch maxPositionPct 3 % = 30 EUR.
    const result = computePositionSize(base);
    expect(result.candidates.RISK_BUDGET).toEqual(eur(50));
    expect(result.size).toEqual(eur(30));
    expect(result.bindingConstraint).toBe("PORTFOLIO_CAP");
  });

  it("laesst die Liquiditaet binden, wenn sie am engsten ist", () => {
    // Der Fall, den die meisten Bots ignorieren.
    const result = computePositionSize({ ...base, maxNotionalByLiquidity: eur(12) });
    expect(result.size).toEqual(eur(12));
    expect(result.bindingConstraint).toBe("LIQUIDITY");
  });

  it("verkleinert bei duenner EV-Stichprobe", () => {
    const confident = computePositionSize({ ...base, maxNotionalByLiquidity: eur(1_000) });
    const unsure = computePositionSize({
      ...base,
      maxNotionalByLiquidity: eur(1_000),
      evConfidence: 0,
    });
    expect(unsure.size.minor).toBeLessThan(confident.size.minor);
    expect(unsure.bindingConstraint).toBe("CONFIDENCE");
  });

  it("verhindert den Trade nicht heimlich ueber die Konfidenz", () => {
    // Untergrenze 0.25: eine schwache Schaetzung verkleinert, sie blockiert nicht.
    // Ob gehandelt wird, entscheiden die Hard Gates — sichtbar und begruendet.
    expect(confidenceFactor(0)).toBe(0.25);
    expect(confidenceFactor(1)).toBe(1);
  });

  it("markiert eine zu kleine Position als nicht handelbar", () => {
    const result = computePositionSize({
      ...base,
      maxNotionalByLiquidity: eur(2),
      minimumNotional: eur(5),
    });
    expect(result.tradeable).toBe(false);
    expect(result.bindingConstraint).toBe("BELOW_MINIMUM");
  });

  it("lehnt einen unsinnigen Stopabstand ab", () => {
    expect(() => computePositionSize({ ...base, stopDistance: 0 })).toThrow(RangeError);
    expect(() => computePositionSize({ ...base, stopDistance: 1.5 })).toThrow(RangeError);
  });
});

describe("Eigenschaften", () => {
  it("ueberschreitet nie eine der vier Grenzen", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 100 }),
        (portfolioEur, stopPct, liquidityEur, confidencePct) => {
          const result = computePositionSize({
            ...base,
            portfolioValue: eur(portfolioEur),
            stopDistance: stopPct / 100,
            maxNotionalByLiquidity: eur(liquidityEur),
            evConfidence: confidencePct / 100,
          });
          for (const candidate of Object.values(result.candidates)) {
            expect(result.size.minor).toBeLessThanOrEqual(candidate.minor);
          }
        },
      ),
    );
  });

  it("waechst nie schneller als das Portfolio", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 50_000 }), (portfolioEur) => {
        const result = computePositionSize({
          ...base,
          portfolioValue: eur(portfolioEur),
          maxNotionalByLiquidity: eur(1_000_000),
        });
        const maxPct = DEFAULT_STRATEGY_PARAMETERS.risk.maxPositionPct;
        expect(Number(result.size.minor)).toBeLessThanOrEqual(
          Number(eur(portfolioEur).minor) * (maxPct / 100) + 1,
        );
      }),
    );
  });
});
