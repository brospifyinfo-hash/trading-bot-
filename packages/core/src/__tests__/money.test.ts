import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyBps,
  bps,
  BPS_DENOMINATOR,
  differenceBps,
  eur,
  formatMoney,
  formatTokenAmount,
  lamports,
  mulDiv,
  subtractBps,
  sumMoney,
  tokenAmount,
} from "../money";

describe("mulDiv", () => {
  it("rundet nach dem angegebenen Modus", () => {
    expect(mulDiv(10n, 1n, 3n, "floor")).toBe(3n);
    expect(mulDiv(10n, 1n, 3n, "ceil")).toBe(4n);
    expect(mulDiv(10n, 1n, 3n, "half-up")).toBe(3n);
    expect(mulDiv(5n, 1n, 2n, "half-up")).toBe(3n);
  });

  it("rundet negative Werte betragsmaessig konsistent", () => {
    expect(mulDiv(-10n, 1n, 3n, "floor")).toBe(-4n);
    expect(mulDiv(-10n, 1n, 3n, "ceil")).toBe(-3n);
  });

  it("wirft bei Division durch Null", () => {
    expect(() => mulDiv(1n, 1n, 0n, "floor")).toThrow(RangeError);
  });

  it("bleibt exakt jenseits der sicheren Double-Praezision", () => {
    // 2^53 + 1 — als Double nicht mehr exakt darstellbar.
    const huge = 9_007_199_254_740_993n;
    expect(mulDiv(huge, 2n, 1n, "floor")).toBe(huge * 2n);
  });
});

describe("Basispunkte", () => {
  it("applyBps entspricht dem erwarteten Prozentsatz", () => {
    expect(applyBps(10_000n, bps(30))).toBe(30n); // 0,30 %
    expect(applyBps(1_000_000n, bps(2500))).toBe(250_000n); // 25 %
  });

  it("subtractBps rundet immer ab", () => {
    // Eine garantierte Mindestausgabemenge darf nie zu hoch angesetzt werden,
    // sonst schlaegt die Transaktion on-chain fehl.
    // 1001 * 9950 / 10000 = 995,995 -> 995, nicht 996.
    expect(subtractBps(1001n, bps(50))).toBe(995n);
  });

  it("differenceBps misst die relative Abweichung", () => {
    expect(differenceBps(100n, 125n)).toBe(2500);
    expect(differenceBps(100n, 75n)).toBe(-2500);
  });

  it("verweigert eine Abweichung relativ zu Null", () => {
    expect(() => differenceBps(0n, 10n)).toThrow(RangeError);
  });

  it("verweigert nicht ganzzahlige Basispunkte", () => {
    expect(() => bps(12.5)).toThrow(TypeError);
  });
});

describe("Money", () => {
  it("summiert exakt, auch ueber viele Positionen", () => {
    const parts = Array.from({ length: 3 }, () => eur(0.1));
    expect(sumMoney(parts, "EUR").minor).toBe(30n);
  });

  it("verweigert das Mischen von Waehrungen", () => {
    expect(() => sumMoney([eur(1), { minor: 1n, currency: "USD" }], "EUR")).toThrow(TypeError);
  });

  it("formatiert mit zwei Nachkommastellen", () => {
    expect(formatMoney(eur(137.4))).toBe("€137.40");
    expect(formatMoney(eur(-2.31))).toBe("-€2.31");
  });

  it("lehnt negative Lamports ab", () => {
    expect(() => lamports(-1n)).toThrow(RangeError);
  });
});

describe("TokenAmount", () => {
  it("formatiert ohne Praezisionsverlust", () => {
    expect(formatTokenAmount(tokenAmount(1_500_000_000n, 9))).toBe("1.5");
    expect(formatTokenAmount(tokenAmount(1n, 9))).toBe("0.000000001");
  });

  it("lehnt unplausible Dezimalstellen ab", () => {
    expect(() => tokenAmount(1n, 19)).toThrow(RangeError);
  });
});

describe("Eigenschaften", () => {
  it("applyBps ist nie groesser als der Ausgangswert bei Raten <= 100 %", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: BPS_DENOMINATOR }),
        (value, rate) => {
          expect(applyBps(value, bps(rate), "floor")).toBeLessThanOrEqual(value);
        },
      ),
    );
  });

  it("subtractBps liegt immer zwischen 0 und dem Ausgangswert", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 0, max: BPS_DENOMINATOR }),
        (value, rate) => {
          const result = subtractBps(value, bps(rate));
          expect(result).toBeGreaterThanOrEqual(0n);
          expect(result).toBeLessThanOrEqual(value);
        },
      ),
    );
  });

  it("Summe von Teilbetraegen ist unabhaengig von der Reihenfolge", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -10_000, max: 10_000 }), { maxLength: 40 }), (xs) => {
        const forward = sumMoney(xs.map((x) => eur(x / 100)), "EUR");
        const backward = sumMoney([...xs].reverse().map((x) => eur(x / 100)), "EUR");
        expect(forward.minor).toBe(backward.minor);
      }),
    );
  });
});
