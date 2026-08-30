import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { TokenBucket } from "../rate-limiter";

const T0 = new Date("2026-08-30T12:00:00Z");

describe("TokenBucket", () => {
  it("gibt zu Beginn die volle Kapazitaet frei", () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 1, clock: new FixedClock(T0) });
    expect(bucket.available).toBe(5);
    for (let i = 0; i < 5; i++) expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("fuellt zeitproportional nach", () => {
    const clock = new FixedClock(T0);
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 2, clock });
    for (let i = 0; i < 10; i++) bucket.tryTake();
    expect(bucket.available).toBe(0);
    clock.advance(2_500);
    expect(bucket.available).toBe(5);
  });

  it("laeuft nicht ueber die Kapazitaet hinaus", () => {
    const clock = new FixedClock(T0);
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 100, clock });
    clock.advance(60_000);
    expect(bucket.available).toBe(3);
  });

  it("sagt, wie lange gewartet werden muesste", () => {
    // Bewusst nur eine Auskunft, kein Warten: bei einer Exit-Pruefung ist eine
    // Sekunde Verzoegerung etwas anderes als bei Discovery. Die Entscheidung
    // bleibt beim Aufrufer.
    const clock = new FixedClock(T0);
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    bucket.tryTake();
    bucket.tryTake();
    expect(bucket.waitMs()).toBe(1_000);
    clock.advance(400);
    expect(bucket.waitMs()).toBe(600);
  });

  it("lehnt unsinnige Konfiguration ab", () => {
    expect(
      () => new TokenBucket({ capacity: 0, refillPerSecond: 1, clock: new FixedClock(T0) }),
    ).toThrow(RangeError);
  });
});
