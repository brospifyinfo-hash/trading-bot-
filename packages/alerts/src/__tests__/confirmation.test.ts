import { describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import { evaluateConfirmation, type ConfirmationInput } from "../confirmation";
import type { MarketSnapshot } from "../revalidation";

/**
 * INVEST NOW.
 *
 * Der Test prueft vor allem, wann NICHT bestaetigt wird. Ein
 * Bestaetigungs-Flow, der zu oft durchlaesst, ist gefaehrlicher als einer, der
 * zu oft blockiert: die erste Fehlerart kostet Geld, die zweite eine
 * Gelegenheit.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

class FixedClock implements Clock {
  constructor(private readonly t: Date) {}
  now(): Date {
    return this.t;
  }
}

const ALERT: MarketSnapshot = {
  priceUsd: 0.00042,
  liquidityUsd: 180_000,
  finalScore: 84,
  riskLevel: "LOW",
  at: T0,
};

function input(overrides: Partial<ConfirmationInput> = {}): ConfirmationInput {
  return {
    tokenValid: true,
    opportunity: {
      id: "opp-1",
      stream: "MANUAL_PAPER",
      state: "OFFERED",
      respondBy: at(300_000),
      sourceType: "LIVE",
    },
    atAlert: ALERT,
    now: { ...ALERT, at: at(60_000) },
    noLiveDataReason: "Keine Marktdatenquelle erreichbar.",
    expectedValue: 0.18,
    portfolio: { openPositions: 1, maxOpenPositions: 5 },
    liveTradingRequested: false,
    clock: new FixedClock(at(60_000)),
    newRevalidationId: () => "reval-1",
    ...overrides,
  };
}

describe("Bestaetigung bei unveraenderter Lage", () => {
  it("bestaetigt und loest ausschliesslich Paper Trading aus", () => {
    const result = evaluateConfirmation(input());
    expect(result.kind).toBe("CONFIRM");
    if (result.kind !== "CONFIRM") return;
    expect(result.executes).toBe("PAPER");
    expect(result.revalidationId).toBe("reval-1");
    // Die Bestaetigung ist kurz gueltig — zwischen Klick und Ausfuehrung
    // vergehen Sekunden, und in Sekunden passiert bei Memecoins genug.
    expect(result.validUntil.getTime()).toBeGreaterThan(at(60_000).getTime());
  });
});

describe("BLOCK-Faelle", () => {
  it("blockiert Live-Handel vollstaendig", () => {
    const result = evaluateConfirmation(input({ liveTradingRequested: true }));
    expect(result.kind).toBe("BLOCK");
    if (result.kind === "BLOCK") expect(result.reason).toBe("LIVE_TRADING_DISABLED");
  });

  it("blockiert einen ungueltigen Link", () => {
    const result = evaluateConfirmation(input({ tokenValid: false }));
    if (result.kind === "BLOCK") expect(result.reason).toBe("TOKEN_INVALID");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert eine unbekannte Gelegenheit", () => {
    const result = evaluateConfirmation(input({ opportunity: null }));
    if (result.kind === "BLOCK") expect(result.reason).toBe("OPPORTUNITY_NOT_FOUND");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert den Auto-Strom", () => {
    const result = evaluateConfirmation(
      input({
        opportunity: {
          id: "opp-1",
          stream: "AUTO_PAPER",
          state: "OFFERED",
          respondBy: at(300_000),
          sourceType: "LIVE",
        },
      }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("WRONG_STREAM");
    else throw new Error("Erwartet BLOCK");
  });

  for (const state of ["REJECTED", "EXPIRED", "USER_CONFIRMED", "POSITION_OPENED"] as const) {
    it(`blockiert eine Gelegenheit im Zustand ${state}`, () => {
      const result = evaluateConfirmation(
        input({
          opportunity: {
            id: "opp-1",
            stream: "MANUAL_PAPER",
            state,
            respondBy: at(300_000),
            sourceType: "LIVE",
          },
        }),
      );
      if (result.kind === "BLOCK") expect(result.reason).toBe("ALREADY_RESOLVED");
      else throw new Error("Erwartet BLOCK");
    });
  }

  it("blockiert eine abgelaufene Gelegenheit", () => {
    const result = evaluateConfirmation(input({ clock: new FixedClock(at(400_000)) }));
    if (result.kind === "BLOCK") expect(result.reason).toBe("EXPIRED");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert den Ablauf VOR der Datenfrage", () => {
    // Sonst hiesse die Auskunft „keine Daten", obwohl das Fenster ohnehin zu
    // war — und der Nutzer sucht den Fehler an der falschen Stelle.
    const result = evaluateConfirmation(
      input({ clock: new FixedClock(at(400_000)), now: null }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("EXPIRED");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert ohne aktuelle Marktdaten", () => {
    const result = evaluateConfirmation(input({ now: null }));
    if (result.kind === "BLOCK") {
      expect(result.reason).toBe("NO_LIVE_DATA");
      expect(result.detail).toContain("Marktdatenquelle");
    } else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei zu grosser Preisabweichung nach oben", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, priceUsd: ALERT.priceUsd * 1.6, at: at(60_000) } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("PRICE_DRIFT");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei zu grossem Preisverfall", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, priceUsd: ALERT.priceUsd * 0.5, at: at(60_000) } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("PRICE_DRIFT");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei abgezogener Liquiditaet", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, liquidityUsd: 40_000, at: at(60_000) } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("LIQUIDITY_DROPPED");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei verschlechterter Sicherheitsbewertung", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, riskLevel: "HIGH", at: at(60_000) } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("SECURITY_WORSE");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei gefallenem Score", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, finalScore: 60, at: at(60_000) } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("SCORE_DROPPED");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei nicht mehr positivem Erwartungswert", () => {
    const result = evaluateConfirmation(input({ expectedValue: -0.04 }));
    if (result.kind === "BLOCK") expect(result.reason).toBe("EV_NOT_POSITIVE");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei nicht berechenbarem Erwartungswert", () => {
    // Nicht berechenbar ist nicht dasselbe wie unauffaellig.
    const result = evaluateConfirmation(input({ expectedValue: null }));
    if (result.kind === "BLOCK") expect(result.reason).toBe("EV_NOT_POSITIVE");
    else throw new Error("Erwartet BLOCK");
  });

  it("blockiert bei ausgeschoepftem Portfolio", () => {
    const result = evaluateConfirmation(
      input({ portfolio: { openPositions: 5, maxOpenPositions: 5 } }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("PORTFOLIO_RISK");
    else throw new Error("Erwartet BLOCK");
  });

  it("nennt bei mehreren Problemen das schwerwiegendste", () => {
    // Sicherheit schlaegt Liquiditaet schlaegt Preis.
    const result = evaluateConfirmation(
      input({
        now: {
          priceUsd: ALERT.priceUsd * 1.6,
          liquidityUsd: 40_000,
          finalScore: 50,
          riskLevel: "CRITICAL",
          at: at(60_000),
        },
      }),
    );
    if (result.kind === "BLOCK") expect(result.reason).toBe("SECURITY_WORSE");
    else throw new Error("Erwartet BLOCK");
  });

  it("liefert bei einer Blockade den Diff mit", () => {
    const result = evaluateConfirmation(
      input({ now: { ...ALERT, liquidityUsd: 40_000, at: at(60_000) } }),
    );
    if (result.kind !== "BLOCK") throw new Error("Erwartet BLOCK");
    // Der Nutzer soll sehen, WAS sich geaendert hat, nicht nur dass etwas war.
    const liquidity = result.changes.find((c) => c.field === "Liquiditaet");
    expect(liquidity?.blocking).toBe(true);
    expect(liquidity?.atAlert).not.toBe(liquidity?.now);
  });
});
