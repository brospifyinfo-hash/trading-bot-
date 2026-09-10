import { describe, expect, it } from "vitest";

import {
  RUGCHECK_REPORT_CONTRACT,
  holderConcentration,
  lpLockedPct,
  type RugcheckReport,
} from "../report";

/**
 * Vertragstest gegen ZWEI echte Antworten vom 2026-09-10.
 *
 * Die Zahlen unten sind keine erfundenen Fixtures — sie stammen aus den
 * gemessenen Bodies. Der Memecoin ist der interessante Fall, USDC der stille:
 * ein etablierter Token liefert `topHolders: null` und `totalHolders: 0`, und
 * genau daran scheitern Schemata, die ueberall Werte erwarten.
 */

/** Auszug aus der echten Antwort fuer SIDE EYE BABY, Anteile unveraendert. */
const MEMECOIN: unknown = {
  mint: "7jAxKsGdGS3T9w4pntSN7fgn6iCF65uk3XDZqxzapump",
  token: {
    supply: 633335122268411,
    decimals: 6,
    isInitialized: true,
    mintAuthority: null,
    freezeAuthority: null,
  },
  creator: "AhVn2veujfJoJpmZongYmN5CDocZKmUbB4jr6CUrqF97",
  creatorBalance: 3112100470497,
  topHolders: [
    // Der Liquiditaetspool. Groesster "Halter" und gar keiner.
    { address: "EWYJ", pct: 41.92113558375941, owner: "7ZYnU2wrteL7YRiCWDdiMrJYQxKSo4RxoDxGsvPgdKGV", insider: false },
    // Zwei Konten, EIN Besitzer.
    { address: "73TE", pct: 17.48135866576465, owner: "DZAvUwwvBsoTE9hxKJTuMProNCzj4RHtQ9HG9qPEUTW5", insider: false },
    { address: "7dRw", pct: 11.447493980804948, owner: "DZAvUwwvBsoTE9hxKJTuMProNCzj4RHtQ9HG9qPEUTW5", insider: false },
    { address: "9VG6", pct: 6.185142752075637, owner: "5zF4URhvV6AWNk2USeQFHaEwHLawT4cJouYBRag5oMWq", insider: false },
    { address: "DX5V", pct: 5.798334703592932, owner: "AcQt8vrMcoNiPqCjZuUMCDkHdm9C59WNNzFkKPAUcudA", insider: false },
    { address: "Gy3R", pct: 4.767966403812554, owner: "2nuG45WeK77xXigTPxUGyLcPYTPEMjCcJ6SjGok9UqUz", insider: false },
    { address: "71jD", pct: 2.8038263602993774, owner: "54Pk5cQLSsjJg8gDehSyTLGppKvtoXpGG9bhQwoD9TB6", insider: false },
    { address: "CACu", pct: 2.0031143083560776, owner: "AHUcdE9dxzgEyyasdY4s9ft2JovHfzNvPDUAPynXCabk", insider: false },
    { address: "7DLQ", pct: 1.8560874758753798, owner: "EsBF9YBRA5au6eEdz7SBax1wc7NDZT8uaCTMxFhWHZ1S", insider: false },
    { address: "YAMi", pct: 1.4363722080782722, owner: "3WDDqV54woevq8Yqbibeof6RTtq7Nhtog1pYhf6iWtaX", insider: false },
    { address: "64By", pct: 1.003424702953028, owner: "DxG6u6xqShxrsAov7jr87JT8Tfnd9e5spiiK1rYxQyhy", insider: false },
    { address: "A54u", pct: 0.9468674702206872, owner: "GGykzrTTmd2KmmitV7hirYyeCvMt1svqNyn1st7MwXVA", insider: false },
    // Der Ersteller.
    { address: "EatJ", pct: 0.49138289683831465, owner: "AhVn2veujfJoJpmZongYmN5CDocZKmUbB4jr6CUrqF97", insider: false },
  ],
  knownAccounts: {
    "7ZYnU2wrteL7YRiCWDdiMrJYQxKSo4RxoDxGsvPgdKGV": { name: "Pump Fun AMM", type: "AMM" },
    "5erPtVjfSVDJ4ShRqXQAUVuqoV6RnCxCeL1tmoUQAVwd": { name: "Printr Stake Pool", type: "LOCKER" },
    AhVn2veujfJoJpmZongYmN5CDocZKmUbB4jr6CUrqF97: { name: "Creator", type: "CREATOR" },
  },
  markets: [{ pubkey: "7ZYn", lp: { lpLockedPct: 72.88609462683779, lpLocked: 4193935466986 } }],
  risks: [
    {
      name: "High holder concentration",
      description: "The top 10 users hold more than 50% token supply",
      score: 1037,
      level: "warn",
    },
  ],
  score: 1038,
  score_normalised: 22,
  rugged: false,
  totalHolders: 335,
};

/** Auszug aus der echten Antwort fuer USDC. Fast alles leer. */
const USDC: unknown = {
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  token: {
    supply: 7997876004536642,
    decimals: 6,
    isInitialized: true,
    mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
    freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
  },
  topHolders: null,
  knownAccounts: {
    "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9": { name: "Creator", type: "CREATOR" },
  },
  // Auf oberster Ebene ein ganzes Konto-Objekt — die Falle, siehe report.ts.
  mintAuthority: { lamports: 55633622, owner: "Tokenkeg", executable: false, space: 355 },
  freezeAuthority: { lamports: 16361680, owner: "Tokenkeg", executable: false, space: 355 },
  markets: null,
  risks: [],
  score: 1,
  score_normalised: 1,
  rugged: false,
  totalHolders: 0,
};

function valid(raw: unknown): RugcheckReport {
  const result = RUGCHECK_REPORT_CONTRACT.validate(raw);
  if (result.kind !== "VALID") throw new Error(`Vertrag lehnt ab: ${result.reason}`);
  return result.value;
}

describe("Vertrag", () => {
  it("ist geprueft und traegt eine Version", () => {
    expect(RUGCHECK_REPORT_CONTRACT.verified).toBe(true);
    expect(RUGCHECK_REPORT_CONTRACT.schemaVersion).toBe("rugcheck-report-v1@2026-09-10");
  });

  it("nimmt beide gemessenen Antworten an", () => {
    expect(RUGCHECK_REPORT_CONTRACT.validate(MEMECOIN).kind).toBe("VALID");
    expect(RUGCHECK_REPORT_CONTRACT.validate(USDC).kind).toBe("VALID");
  });

  /**
   * Die Falle: `mintAuthority` gibt es zweimal. Auf oberster Ebene ist es bei
   * USDC ein Konto-OBJEKT, unter `token` eine Adresse. Wer die obere Ebene
   * als Wahrheitswert liest, haelt USDC fuer sicher und den Memecoin fuer
   * gefaehrlich — also genau verkehrt herum.
   */
  it("liest die Autoritaeten aus token, nicht von der obersten Ebene", () => {
    expect(valid(USDC).token.mintAuthority).toBe("BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG");
    expect(valid(MEMECOIN).token.mintAuthority).toBeNull();
    expect(valid(MEMECOIN).token.freezeAuthority).toBeNull();
  });
});

describe("Konzentration nach Besitzern", () => {
  it("schliesst den Liquiditaetspool aus und fasst Konten desselben Besitzers zusammen", () => {
    const c = holderConcentration(valid(MEMECOIN));
    if (c === null) throw new Error("erwartet: Konzentration");

    // Roh waeren es 95,70 % ueber zehn KONTEN. Ohne Pool und nach Besitzern
    // zusammengefasst bleiben 55,7 % — das ist die Zahl, die etwas ueber
    // Machtverteilung sagt.
    expect(c.top10Pct).toBeCloseTo(55.73, 1);
    expect(c.top10Pct).not.toBeCloseTo(95.7, 1);

    // Der groesste Akteur haelt 28,9 % (zwei Konten), nicht 41,9 % (der Pool).
    expect(c.topPct).toBeCloseTo(28.93, 2);
    expect(c.excludedAccounts).toBe(1);
  });

  it("nennt den Anteil des Erstellers", () => {
    // Er wird ausdruecklich NICHT ausgeschlossen: der Ersteller ist der
    // risikoreichste Halter, nicht ein Infrastrukturkonto.
    const c = holderConcentration(valid(MEMECOIN));
    expect(c?.creatorPct).toBeCloseTo(0.49138, 4);
  });

  it("zaehlt Besitzer, nicht Konten", () => {
    const c = holderConcentration(valid(MEMECOIN));
    // 13 Konten, davon 1 Pool ausgeschlossen, und zwei teilen sich einen
    // Besitzer: 11 eigenstaendige Akteure.
    expect(c?.distinctOwners).toBe(11);
  });

  it("liefert bei USDC nichts statt null Prozent", () => {
    // `topHolders: null` heisst „nicht ermittelt". Daraus „keine
    // Konzentration" zu machen waere eine Sicherheitsaussage, die niemand
    // geprueft hat — und ausgerechnet fuer den unbedenklichsten Token.
    expect(holderConcentration(valid(USDC))).toBeNull();
  });

  it("liefert nichts, wenn NUR Pools in der Liste stehen", () => {
    const nurPool = {
      ...(MEMECOIN as Record<string, unknown>),
      topHolders: [
        { address: "EWYJ", pct: 99, owner: "7ZYnU2wrteL7YRiCWDdiMrJYQxKSo4RxoDxGsvPgdKGV" },
      ],
    };
    expect(holderConcentration(valid(nurPool))).toBeNull();
  });
});

describe("LP-Sperrung", () => {
  it("nimmt den hoechsten gemeldeten Anteil", () => {
    expect(lpLockedPct(valid(MEMECOIN))).toBeCloseTo(72.886, 3);
  });

  it("liefert ohne Markt nichts", () => {
    // Bei USDC ist `markets` null — kein LP-Feld, kein Ersatzwert.
    expect(lpLockedPct(valid(USDC))).toBeNull();
  });
});
