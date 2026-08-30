import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { ProviderBudget } from "../budget";

const T0 = new Date("2026-08-30T12:00:00Z");

describe("ProviderBudget", () => {
  it("verbraucht Budget je Anfrage", () => {
    const budget = new ProviderBudget({
      monthlyLimitUsd: 1,
      costPerRequestUsd: 0.001,
      clock: new FixedClock(T0),
    });
    for (let i = 0; i < 500; i++) budget.chargeRequest();
    expect(budget.usedFraction).toBeCloseTo(0.5, 3);
    expect(budget.exhausted).toBe(false);
  });

  it("erkennt das erschoepfte Budget", () => {
    const budget = new ProviderBudget({
      monthlyLimitUsd: 1,
      costPerRequestUsd: 0.01,
      clock: new FixedClock(T0),
    });
    for (let i = 0; i < 100; i++) budget.chargeRequest();
    expect(budget.exhausted).toBe(true);
    // Der letzte Aufruf meldet, dass danach nichts mehr uebrig ist.
    expect(budget.chargeRequest()).toBe(false);
  });

  it("beginnt im neuen Monat von vorn", () => {
    const clock = new FixedClock(T0);
    const budget = new ProviderBudget({
      monthlyLimitUsd: 1,
      costPerRequestUsd: 1,
      clock,
    });
    budget.chargeRequest();
    expect(budget.exhausted).toBe(true);
    clock.set(new Date("2026-09-01T00:00:00Z"));
    expect(budget.exhausted).toBe(false);
    expect(budget.usedFraction).toBe(0);
  });

  it("bleibt im Folgemonat nicht blockiert, ohne dass etwas gebucht wird", () => {
    // Die Verklemmung: `exhausted` blockiert jede Anfrage, und nur eine Anfrage
    // haette den Monatswechsel bemerkt. Der Provider waere dauerhaft still
    // abgeschaltet gewesen.
    const clock = new FixedClock(T0);
    const budget = new ProviderBudget({
      monthlyLimitUsd: 1,
      costPerRequestUsd: 1,
      clock,
    });
    budget.chargeRequest();
    clock.set(new Date("2026-10-15T00:00:00Z"));
    // Nur lesen, nichts buchen — muss trotzdem freigeben.
    expect(budget.exhausted).toBe(false);
  });
});
