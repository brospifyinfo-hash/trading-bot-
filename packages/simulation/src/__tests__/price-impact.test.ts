import { describe, expect, it } from "vitest";
import { bps } from "@sae/core";
import fc from "fast-check";
import { estimateSwap, maxAmountWithinImpact } from "../price-impact";

const pool = (inR: bigint, outR: bigint, fee = 30) => ({
  reserveIn: inR,
  reserveOut: outR,
  feeBps: bps(fee),
});

describe("estimateSwap", () => {
  it("liefert bei winzigem Input nahezu den Spotpreis", () => {
    const r = estimateSwap(1_000n, pool(1_000_000_000n, 1_000_000_000n, 0));
    expect(r.priceImpactBps).toBeLessThanOrEqual(1);
  });

  it("erzeugt bei grossem Input erheblichen Impact", () => {
    // 10 % der Reserve hinein: Impact liegt bei rund 9 % (dx/(x+dx)).
    const r = estimateSwap(100_000_000n, pool(1_000_000_000n, 1_000_000_000n, 0));
    expect(r.priceImpactBps).toBeGreaterThan(800);
    expect(r.priceImpactBps).toBeLessThan(1_000);
  });

  it("zieht die Gebuehr vom Input ab", () => {
    const withFee = estimateSwap(1_000_000n, pool(10n ** 12n, 10n ** 12n, 100));
    const withoutFee = estimateSwap(1_000_000n, pool(10n ** 12n, 10n ** 12n, 0));
    expect(withFee.feeAmount).toBe(10_000n);
    expect(withFee.amountOut).toBeLessThan(withoutFee.amountOut);
  });

  it("trennt Gebuehr vom Impact", () => {
    // Eine reine Gebuehr ohne Kurvenkruemmung darf nicht als Impact erscheinen.
    const r = estimateSwap(1_000n, pool(10n ** 15n, 10n ** 15n, 100));
    expect(r.feeAmount).toBeGreaterThan(0n);
    expect(r.priceImpactBps).toBe(0);
  });

  it("lehnt leere Pools ab", () => {
    expect(() => estimateSwap(1n, pool(0n, 1n))).toThrow(RangeError);
  });

  it("gibt bei Input 0 auch 0 zurueck", () => {
    const r = estimateSwap(0n, pool(1_000n, 1_000n));
    expect(r.amountOut).toBe(0n);
    expect(r.priceImpactBps).toBe(0);
  });
});

describe("maxAmountWithinImpact", () => {
  it("respektiert die Impact-Obergrenze", () => {
    const reserve = 1_000_000_000n;
    const maxAmount = maxAmountWithinImpact(reserve, bps(200)); // 2 %
    const actual = estimateSwap(maxAmount, pool(reserve, reserve, 0));
    expect(actual.priceImpactBps).toBeLessThanOrEqual(200);
  });

  it("liefert 0 bei einer Obergrenze von 0", () => {
    expect(maxAmountWithinImpact(1_000n, bps(0))).toBe(0n);
  });
});

describe("Eigenschaften", () => {
  it("Ausgabe ist nie groesser als die Ausgabereserve", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        fc.bigInt({ min: 1n, max: 10n ** 15n }),
        (amountIn, reserveIn, reserveOut) => {
          const r = estimateSwap(amountIn, pool(reserveIn, reserveOut, 30));
          expect(r.amountOut).toBeLessThan(reserveOut);
        },
      ),
    );
  });

  it("Impact waechst monoton mit der Ordergroesse", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 6n, max: 10n ** 12n }),
        fc.bigInt({ min: 10n ** 9n, max: 10n ** 15n }),
        (amountIn, reserve) => {
          const small = estimateSwap(amountIn, pool(reserve, reserve, 0));
          const large = estimateSwap(amountIn * 2n, pool(reserve, reserve, 0));
          expect(large.priceImpactBps).toBeGreaterThanOrEqual(small.priceImpactBps);
        },
      ),
    );
  });
});
