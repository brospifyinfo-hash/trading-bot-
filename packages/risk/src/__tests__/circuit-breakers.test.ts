import { describe, expect, it } from "vitest";
import { FixedClock, eur } from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { BREAKERS, assessBreakers, type BreakerState } from "../circuit-breakers";
import type { PortfolioState } from "../portfolio";

const T0 = new Date("2026-08-30T12:00:00Z");
const clock = new FixedClock(T0);

const portfolio = (overrides: Partial<PortfolioState> = {}): PortfolioState => ({
  value: eur(1_000),
  openPositions: [],
  realizedTodayPnl: eur(0),
  consecutiveLosses: 0,
  ...overrides,
});

const assess = (overrides: Partial<Parameters<typeof assessBreakers>[0]> = {}) =>
  assessBreakers({
    persisted: [],
    portfolio: portfolio(),
    parameters: DEFAULT_STRATEGY_PARAMETERS,
    criticalProvidersUnavailable: [],
    dataStale: false,
    clock,
    ...overrides,
  });

describe("assessBreakers", () => {
  it("laesst bei ruhiger Lage alles zu", () => {
    const result = assess();
    expect(result.entriesBlocked).toBe(false);
    expect(result.allTradingBlocked).toBe(false);
  });

  it("loest bei erreichter Tagesverlustgrenze aus", () => {
    // 5 % von 1000 EUR = 50 EUR.
    const result = assess({
      portfolio: portfolio({ realizedTodayPnl: eur(-50) }),
    });
    expect(result.entriesBlocked).toBe(true);
    expect(result.open.map((b) => b.name)).toContain("DAILY_LOSS");
  });

  it("blockiert bei Tagesverlust nur Einstiege, nicht Ausstiege", () => {
    // Positionsverwaltung muss weiterlaufen: sonst haelt das System seine
    // Verlustpositionen genau dann fest, wenn es sie loswerden sollte.
    const result = assess({ portfolio: portfolio({ realizedTodayPnl: eur(-100) }) });
    expect(result.entriesBlocked).toBe(true);
    expect(result.allTradingBlocked).toBe(false);
  });

  it("loest bei zu vielen Verlusten in Folge aus", () => {
    const result = assess({ portfolio: portfolio({ consecutiveLosses: 4 }) });
    expect(result.open.map((b) => b.name)).toContain("CONSECUTIVE_LOSSES");
  });

  it("blockiert bei ausgefallener kritischer Datenquelle", () => {
    const result = assess({ criticalProvidersUnavailable: ["router"] });
    expect(result.entriesBlocked).toBe(true);
    expect(result.reasons.join(" ")).toContain("router");
  });

  it("blockiert bei veralteten Daten", () => {
    expect(assess({ dataStale: true }).entriesBlocked).toBe(true);
  });

  it("haelt bei Bestandsabweichung ALLES an", () => {
    // Wenn interner und tatsaechlicher Bestand auseinanderlaufen, ist auch ein
    // Verkauf ein Schuss ins Dunkle.
    const persisted: BreakerState[] = [
      {
        name: "RECONCILIATION_DRIFT",
        state: "OPEN",
        openedAt: T0,
        cooldownUntil: null,
        reason: "Bestand weicht ab",
      },
    ];
    const result = assess({ persisted });
    expect(result.allTradingBlocked).toBe(true);
  });

  it("respektiert einen gespeicherten Lockout, auch wenn die Bedingung entfallen ist", () => {
    // Ein kurz erholtes Portfolio darf den Lockout nicht aufheben.
    const persisted: BreakerState[] = [
      {
        name: "DAILY_LOSS",
        state: "OPEN",
        openedAt: T0,
        cooldownUntil: new Date(T0.getTime() + 3_600_000),
        reason: "Tagesverlust erreicht",
      },
    ];
    const result = assess({ persisted, portfolio: portfolio({ realizedTodayPnl: eur(0) }) });
    expect(result.entriesBlocked).toBe(true);
  });

  it("gibt nach Ablauf der Abkuehlzeit wieder frei", () => {
    const persisted: BreakerState[] = [
      {
        name: "DAILY_LOSS",
        state: "OPEN",
        openedAt: new Date(T0.getTime() - 7_200_000),
        cooldownUntil: new Date(T0.getTime() - 60_000),
        reason: "Tagesverlust erreicht",
      },
    ];
    expect(assess({ persisted }).entriesBlocked).toBe(false);
  });

  it("meldet jeden Breaker nur einmal", () => {
    const persisted: BreakerState[] = [
      { name: "DAILY_LOSS", state: "OPEN", openedAt: T0, cooldownUntil: null, reason: "gespeichert" },
    ];
    const result = assess({ persisted, portfolio: portfolio({ realizedTodayPnl: eur(-200) }) });
    expect(result.open.filter((b) => b.name === "DAILY_LOSS")).toHaveLength(1);
  });

  it("erlaubt nur zwei Breakern, alles anzuhalten", () => {
    // Die Asymmetrie ist Absicht und soll nicht versehentlich aufweichen.
    const allTrading = Object.values(BREAKERS)
      .filter((b) => b.scope === "ALL_TRADING")
      .map((b) => b.name)
      .sort();
    expect(allTrading).toEqual(["EMERGENCY_STOP", "RECONCILIATION_DRIFT"]);
  });
});
