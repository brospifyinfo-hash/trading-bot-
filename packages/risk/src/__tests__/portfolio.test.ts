import { describe, expect, it } from "vitest";
import { eur } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { checkExposure, dailyLossPct, type PortfolioState } from "../portfolio";

const state = (overrides: Partial<PortfolioState> = {}): PortfolioState => ({
  value: eur(1_000),
  openPositions: [],
  realizedTodayPnl: eur(0),
  consecutiveLosses: 0,
  ...overrides,
});

describe("checkExposure", () => {
  it("summiert die offenen Positionen", () => {
    const result = checkExposure(
      state({
        openPositions: [
          { tokenId: "a", notional: eur(30) },
          { tokenId: "b", notional: eur(20) },
        ],
      }),
      eur(25),
      DEFAULT_STRATEGY_PARAMETERS,
    );
    expect(result.currentExposure).toEqual(eur(50));
    expect(result.exposureAfterTrade).toEqual(eur(75));
    expect(result.exposurePctAfterTrade).toBeCloseTo(7.5, 4);
    expect(result.withinLimits).toBe(true);
  });

  it("blockiert ueber der Exposure-Grenze", () => {
    // 15 % von 1000 EUR = 150 EUR.
    const result = checkExposure(
      state({ openPositions: [{ tokenId: "a", notional: eur(145) }] }),
      eur(30),
      DEFAULT_STRATEGY_PARAMETERS,
    );
    expect(result.withinLimits).toBe(false);
    expect(result.violations).toContain("PORTFOLIO_EXPOSURE_LIMIT");
  });

  it("blockiert bei erreichter Positionsobergrenze", () => {
    const positions = Array.from({ length: 5 }, (_, i) => ({
      tokenId: `t${i}`,
      notional: eur(5),
    }));
    const result = checkExposure(
      state({ openPositions: positions }),
      eur(5),
      DEFAULT_STRATEGY_PARAMETERS,
    );
    expect(result.violations).toContain("MAX_OPEN_POSITIONS_REACHED");
  });

  it("lehnt Positionen in fremder Waehrung ab", () => {
    expect(() =>
      checkExposure(
        state({ openPositions: [{ tokenId: "a", notional: { minor: 100n, currency: "USD" } }] }),
        eur(10),
        DEFAULT_STRATEGY_PARAMETERS,
      ),
    ).toThrow(TypeError);
  });
});

describe("dailyLossPct", () => {
  it("meldet 0 bei Gewinn", () => {
    expect(dailyLossPct(state({ realizedTodayPnl: eur(50) }))).toBe(0);
  });

  it("rechnet den Verlust als positiven Prozentsatz", () => {
    expect(dailyLossPct(state({ realizedTodayPnl: eur(-45) }))).toBeCloseTo(4.5, 4);
  });

  it("rundet zulasten des Systems auf", () => {
    // Ein knapp verfehltes Limit soll eher ausloesen als knapp durchrutschen.
    const value = dailyLossPct(state({ value: eur(1_000), realizedTodayPnl: eur(-49.999) }));
    expect(value).toBeGreaterThanOrEqual(4.9999);
  });
});
