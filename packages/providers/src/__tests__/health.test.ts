import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { HealthTracker } from "../health";
import { CircuitBreaker } from "../circuit-breaker";
import { ProviderBudget } from "../budget";

const T0 = new Date("2026-08-30T12:00:00Z");

describe("HealthTracker", () => {
  it("meldet HEALTHY nach erfolgreichen Aufrufen", () => {
    const tracker = new HealthTracker({ clock: new FixedClock(T0) });
    for (let i = 0; i < 10; i++) tracker.recordSuccess(100);
    expect(tracker.state().status).toBe("HEALTHY");
  });

  it("meldet DEGRADED ab der Fehlerratenschwelle", () => {
    const tracker = new HealthTracker({ clock: new FixedClock(T0), degradedErrorRate: 0.2 });
    for (let i = 0; i < 8; i++) tracker.recordSuccess(50);
    tracker.recordFailure("HTTP 500");
    tracker.recordFailure("HTTP 500");
    expect(tracker.state().status).toBe("DEGRADED");
  });

  it("meldet DOWN bei offenem Circuit Breaker", () => {
    const clock = new FixedClock(T0);
    const tracker = new HealthTracker({ clock });
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, clock });
    tracker.recordSuccess(10);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(tracker.state({ breaker }).status).toBe("DOWN");
  });

  it("meldet DOWN, wenn seit langem kein Aufruf mehr gelungen ist", () => {
    // Ein Provider ist nicht deshalb gesund, weil ihn gerade niemand fragt.
    const clock = new FixedClock(T0);
    const tracker = new HealthTracker({ clock, maxSilenceMs: 60_000 });
    tracker.recordSuccess(10);
    expect(tracker.state().status).toBe("HEALTHY");
    clock.advance(61_000);
    expect(tracker.state().status).toBe("DOWN");
  });

  it("meldet DOWN, wenn noch nie ein Aufruf gelungen ist", () => {
    const tracker = new HealthTracker({ clock: new FixedClock(T0) });
    tracker.recordFailure("HTTP 500");
    expect(tracker.state().status).toBe("DOWN");
  });

  it("meldet DEGRADED bei aufgebrauchtem Budget", () => {
    const clock = new FixedClock(T0);
    const tracker = new HealthTracker({ clock });
    const budget = new ProviderBudget({ monthlyLimitUsd: 1, costPerRequestUsd: 1, clock });
    tracker.recordSuccess(10);
    budget.chargeRequest();
    const state = tracker.state({ budget });
    expect(state.status).toBe("DEGRADED");
    expect(state.budgetUsedPct).toBeGreaterThanOrEqual(100);
  });

  it("berechnet das 95. Perzentil der Latenz", () => {
    const tracker = new HealthTracker({ clock: new FixedClock(T0) });
    for (let i = 1; i <= 100; i++) tracker.recordSuccess(i);
    expect(tracker.latencyMsP95).toBeGreaterThanOrEqual(90);
  });
});
