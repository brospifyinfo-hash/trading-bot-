import { describe, expect, it } from "vitest";
import { isBase58Address, mint, txSignature, walletAddress } from "../ids";

const VALID_MINT = "So11111111111111111111111111111111111111112";
const VALID_SIG =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

describe("Adressvalidierung", () => {
  it("akzeptiert eine gueltige Mint-Adresse", () => {
    expect(mint(VALID_MINT)).toBe(VALID_MINT);
    expect(isBase58Address(VALID_MINT)).toBe(true);
  });

  it("lehnt zu kurze Adressen ab", () => {
    expect(() => mint("abc")).toThrow(TypeError);
  });

  it("lehnt Zeichen ausserhalb des Base58-Alphabets ab", () => {
    // 0, O, I und l fehlen in Base58 bewusst, weil sie verwechselbar sind.
    expect(() => walletAddress("0".repeat(40))).toThrow(TypeError);
    expect(() => walletAddress(`${"1".repeat(39)}O`)).toThrow(TypeError);
  });

  it("akzeptiert eine gueltige Transaktionssignatur", () => {
    expect(txSignature(VALID_SIG)).toBe(VALID_SIG);
  });

  it("lehnt eine Adresse als Signatur ab", () => {
    // Signaturen sind 64 Byte, Adressen 32 — Verwechslung waere ein Fehler
    // mit Folgen im Reconciliation-Pfad.
    expect(() => txSignature(VALID_MINT)).toThrow(TypeError);
  });
});
