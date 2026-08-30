import { describe, expect, it } from "vitest";
import { halfNormalDrift, mulberry32 } from "../rng";

describe("mulberry32", () => {
  it("liefert bei gleichem Startwert dieselbe Folge", () => {
    // Ein Backtest, der bei jeder Wiederholung etwas anderes ergibt, ist keine
    // Messung, sondern eine Anekdote.
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("liefert bei anderem Startwert eine andere Folge", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it("bleibt im Bereich [0,1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1_000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("ist grob gleichverteilt", () => {
    const r = mulberry32(99);
    const buckets = new Array(10).fill(0) as number[];
    for (let i = 0; i < 10_000; i++) buckets[Math.floor(r() * 10)]! += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1_200);
    }
  });
});

describe("halfNormalDrift", () => {
  it("liefert nie einen negativen Wert", () => {
    // Die Drift geht immer zulasten des Trades — ein Vorzeichenwechsel waere
    // ein eingerechneter Vorteil.
    const r = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      expect(halfNormalDrift(r, 0.004)).toBeGreaterThanOrEqual(0);
    }
  });

  it("erzeugt kleine Abweichungen haeufiger als grosse", () => {
    const r = mulberry32(5);
    const samples = Array.from({ length: 5_000 }, () => halfNormalDrift(r, 0.004));
    const small = samples.filter((s) => s < 0.004).length;
    const large = samples.filter((s) => s > 0.008).length;
    expect(small).toBeGreaterThan(large * 2);
  });

  it("skaliert mit dem Parameter", () => {
    const mean = (scale: number): number => {
      const r = mulberry32(11);
      const samples = Array.from({ length: 5_000 }, () => halfNormalDrift(r, scale));
      return samples.reduce((a, b) => a + b, 0) / samples.length;
    };
    expect(mean(0.008)).toBeGreaterThan(mean(0.004) * 1.5);
  });
});
