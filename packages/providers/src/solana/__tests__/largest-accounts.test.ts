import { describe, expect, it } from "vitest";

import { concentrationOf, toAmounts } from "../largest-accounts";

/**
 * Die Konzentrationsrechnung.
 *
 * Hier wohnen die gefaehrlichen Fehler: eine vertauschte Gesamtmenge
 * verschiebt jeden Anteil, und das Ergebnis saehe trotzdem wie ein
 * Prozentwert aus. Der Abruf selbst ist dagegen langweilig.
 */

/** Die vermutete Form — belegt wird sie von der Sonde im Betrieb. */
const ANTWORT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    context: { slot: 301_234_567 },
    value: [
      { address: "A", amount: "400", decimals: 6, uiAmount: 0.0004, uiAmountString: "0.0004" },
      { address: "B", amount: "100", decimals: 6, uiAmount: 0.0001, uiAmountString: "0.0001" },
      { address: "C", amount: "200", decimals: 6, uiAmount: 0.0002, uiAmountString: "0.0002" },
    ],
  },
};

describe("Mengen lesen", () => {
  it("liefert sie absteigend und als BigInt", () => {
    // Absteigend, weil „die zehn groessten" sonst von der Reihenfolge des
    // Anbieters abhinge. BigInt, weil ein u64 nicht verlustfrei in eine
    // JSON-Zahl passt — und Token-Mengen erreichen diese Groessenordnung.
    expect(toAmounts(ANTWORT)).toEqual([400n, 200n, 100n]);
  });

  it("gibt bei abweichender Form null zurueck", () => {
    expect(toAmounts({ jsonrpc: "2.0", result: { value: "nein" } })).toBeNull();
    expect(toAmounts(null)).toBeNull();
    // Eine Menge als JSON-Zahl statt als Text waere genau der Verlust, gegen
    // den der Anbieter sie als Text schickt.
    expect(
      toAmounts({ ...ANTWORT, result: { ...ANTWORT.result, value: [{ address: "A", amount: 400, decimals: 6 }] } }),
    ).toBeNull();
  });
});

describe("Konzentration rechnen", () => {
  it("rechnet Anteile gegen die Gesamtmenge", () => {
    const c = concentrationOf({ amounts: [400n, 200n, 100n], totalSupplyRaw: 1_000n });
    expect(c?.top10SharePct).toBeCloseTo(70, 6);
    expect(c?.topSharePct).toBeCloseTo(40, 6);
    expect(c?.accountsReported).toBe(3);
  });

  it("nimmt bei mehr als zehn Konten genau die zehn groessten", () => {
    const amounts = [100n, 90n, 80n, 70n, 60n, 50n, 40n, 30n, 20n, 10n, 5n, 5n];
    const c = concentrationOf({ amounts, totalSupplyRaw: 1_000n });
    // 550 von 1000, die beiden Fuenfer bleiben draussen.
    expect(c?.top10SharePct).toBeCloseTo(55, 6);
  });

  it("kommt mit unsortierter Eingabe zurecht", () => {
    const a = concentrationOf({ amounts: [100n, 400n, 200n], totalSupplyRaw: 1_000n });
    const b = concentrationOf({ amounts: [400n, 200n, 100n], totalSupplyRaw: 1_000n });
    expect(a).toEqual(b);
  });

  it("liefert nichts statt Unendlich, wenn es keine Gesamtmenge gibt", () => {
    expect(concentrationOf({ amounts: [1n], totalSupplyRaw: 0n })).toBeNull();
  });

  it("liefert nichts, wenn die Konten die Gesamtmenge uebersteigen", () => {
    // Kann nur heissen, dass Mengen und Gesamtmenge nicht zusammengehoeren —
    // etwa weil die Gesamtmenge von einem anderen Mint stammt. Ein
    // Prozentwert daraus waere schlimmer als keiner: er saehe plausibel aus.
    expect(concentrationOf({ amounts: [600n, 600n], totalSupplyRaw: 1_000n })).toBeNull();
  });

  it("liefert nichts ohne ein einziges Konto", () => {
    expect(concentrationOf({ amounts: [], totalSupplyRaw: 1_000n })).toBeNull();
  });

  it("bleibt bei sehr grossen Mengen genau", () => {
    // Eine Billiarde Token mit neun Stellen: jenseits von
    // Number.MAX_SAFE_INTEGER. Ueber `number` gerechnet waere der Anteil
    // stillschweigend gerundet.
    const supply = 1_000_000_000_000_000_000_000_000n;
    const c = concentrationOf({ amounts: [supply / 4n], totalSupplyRaw: supply });
    expect(c?.topSharePct).toBeCloseTo(25, 6);
  });
});
