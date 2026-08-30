import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { CircuitBreaker } from "../circuit-breaker";

const T0 = new Date("2026-08-30T12:00:00Z");
const make = (clock: FixedClock) =>
  new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, clock });

describe("CircuitBreaker", () => {
  it("bleibt geschlossen unterhalb der Schwelle", () => {
    const breaker = make(new FixedClock(T0));
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("CLOSED");
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("oeffnet bei Erreichen der Schwelle", () => {
    const breaker = make(new FixedClock(T0));
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
    expect(breaker.allowsRequest()).toBe(false);
  });

  it("setzt die Fehlerzaehlung bei Erfolg zurueck", () => {
    const breaker = make(new FixedClock(T0));
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe("CLOSED");
  });

  it("geht nach der Abkuehlzeit in den halboffenen Zustand", () => {
    const clock = new FixedClock(T0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    clock.advance(29_000);
    expect(breaker.state).toBe("OPEN");
    clock.advance(2_000);
    expect(breaker.state).toBe("HALF_OPEN");
    expect(breaker.allowsRequest()).toBe(true);
  });

  it("oeffnet sofort wieder, wenn der Probeversuch scheitert", () => {
    // Kein erneutes Hochzaehlen bis zur Schwelle: der Anbieter hat gerade
    // bewiesen, dass er noch nicht zurueck ist.
    const clock = new FixedClock(T0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    clock.advance(31_000);
    expect(breaker.state).toBe("HALF_OPEN");
    breaker.recordFailure();
    expect(breaker.state).toBe("OPEN");
  });

  it("schliesst, wenn der Probeversuch gelingt", () => {
    const clock = new FixedClock(T0);
    const breaker = make(clock);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    clock.advance(31_000);
    breaker.recordSuccess();
    expect(breaker.state).toBe("CLOSED");
  });
});
