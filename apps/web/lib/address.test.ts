import { describe, expect, it } from "vitest";

import { adresseAusEingabe } from "./address";

const MINT = "BES6pzpnnfuqrun7vdiy7t6hntkbhp8rxobojLfe7c4u";

describe("adresseAusEingabe", () => {
  it("nimmt eine blanke Adresse", () => {
    expect(adresseAusEingabe(MINT)).toBe(MINT);
    expect(adresseAusEingabe(`  ${MINT}  `)).toBe(MINT);
  });

  it("nimmt einen DexScreener-Link, weil genau der eingeklebt wird", () => {
    expect(adresseAusEingabe(`https://dexscreener.com/solana/${MINT}`)).toBe(MINT);
    expect(adresseAusEingabe(`https://dexscreener.com/solana/${MINT}?maker=x`)).toBe(MINT);
    expect(adresseAusEingabe(`https://dexscreener.com/solana/${MINT}/#chart`)).toBe(MINT);
  });

  it("nimmt auch Links, die die Adresse nicht ans Ende haengen", () => {
    expect(adresseAusEingabe(`https://solscan.io/token/${MINT}/holders`)).toBe(MINT);
  });

  it("weist ab, was keine Adresse ist — statt es als Suchbegriff weiterzugeben", () => {
    expect(adresseAusEingabe("")).toBeNull();
    expect(adresseAusEingabe("   ")).toBeNull();
    expect(adresseAusEingabe("Bitcoin")).toBeNull();
    // Zu kurz, und das 0 ist in Base58 gar nicht enthalten.
    expect(adresseAusEingabe("0x00000000000000000000000000000000")).toBeNull();
    expect(adresseAusEingabe("https://dexscreener.com/solana")).toBeNull();
  });

  it("entscheidet nicht zwischen zwei Adressen in einem Link", () => {
    const zweite = "So11111111111111111111111111111111111111112";
    // Ein Paar-Link mit beiden Seiten: raten waere hier schlimmer als fragen.
    expect(adresseAusEingabe(`https://example.com/${zweite}/x/${MINT}`)).toBe(MINT);
    expect(adresseAusEingabe(`https://example.com/${zweite}/${MINT}/pools`)).toBeNull();
  });
});
