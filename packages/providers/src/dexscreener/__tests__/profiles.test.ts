import { describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import { DexScreenerProfilesAdapter } from "../profiles";

/**
 * Der Kandidatenstrom, geprüft gegen eine echte Antwort vom 2026-09-06.
 *
 * Die Stichprobe ist gekürzt, aber jeder enthaltene Eintrag steht wortgleich
 * so in der Antwort — inklusive der Mischung aus fünf Ketten und der
 * Einträge ohne `description` und ohne `links`.
 */

const T0 = new Date("2026-09-06T09:00:00Z");
const clock: Clock = { now: () => T0 };

/** Auszug aus der echten Antwort. Nicht begradigt. */
const ECHTE_ANTWORT = JSON.stringify([
  {
    url: "https://dexscreener.com/bsc/0xd650972126b4384318d33ab7433ac3c161427777",
    chainId: "bsc",
    tokenAddress: "0xD650972126b4384318D33Ab7433AC3C161427777",
    description: "Asster paired with aster",
    links: [{ type: "twitter", url: "https://x.com/asster_onbnb?s=11" }],
    cto: false,
  },
  {
    url: "https://dexscreener.com/solana/33lzgllvtrdx3uafj1ccbsc7pnfqdicbavwpsvkbpump",
    chainId: "solana",
    tokenAddress: "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump",
    // Eintrag ohne links, mit leerer description — kommt so vor.
    description: "",
    cto: false,
  },
  {
    chainId: "robinhood",
    tokenAddress: "0x2D257A62346c6b239C3E746758DC96D8955EE406",
    description: "Vlad Tenev und die Kupfertoepfe",
    cto: false,
  },
  {
    url: "https://dexscreener.com/solana/gsbzlsx8r8nq9qp2fs5oalcqs72ag1sfeyuqbs1apump",
    chainId: "solana",
    tokenAddress: "GSBZLSX8R8nq9qp2fs5oaLcQS72aG1SFEyuqbS1Apump",
    description: "A soul-powered meme born in the neon heart of the chain.",
    links: [
      { label: "Website", url: "https://sollife.live" },
      { type: "twitter", url: "https://x.com/SolanaLifeX" },
    ],
    cto: false,
  },
  {
    chainId: "hyperevm",
    tokenAddress: "0x77c85b76285d5e7Bd510C75EED977E671AE40999",
    description: "Moonjeff paired with SPCX stock",
    cto: false,
  },
]);

function adapterWith(body: string, status = 200) {
  const fetchImpl = (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
  return new DexScreenerProfilesAdapter({ clock, fetchImpl });
}

describe("Kandidatenstrom gegen die echte Antwort", () => {
  it("nimmt nur Solana und verwirft die uebrigen Ketten", async () => {
    // Die Stichprobe mischte bsc, robinhood, hyperevm und solana. Ohne Filter
    // landen EVM-Adressen im System und fallen spaeter als "ungueltig" auf,
    // obwohl sie nur von der falschen Kette kommen.
    const result = await adapterWith(ECHTE_ANTWORT).fetchProfiles();
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;

    expect(result.profiles).toHaveLength(2);
    expect(result.profiles.map((p) => p.mint)).toEqual([
      "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump",
      "GSBZLSX8R8nq9qp2fs5oaLcQS72aG1SFEyuqbS1Apump",
    ]);
  });

  it("vertraegt Eintraege ohne links und ohne Beschreibung", async () => {
    const result = await adapterWith(ECHTE_ANTWORT).fetchProfiles();
    if (result.kind !== "OK") throw new Error(result.kind);
    expect(result.profiles[0]?.links).toEqual([]);
    expect(result.profiles[0]?.description).toBe("");
  });

  it("sammelt die verlinkten Kanaele ein", async () => {
    const result = await adapterWith(ECHTE_ANTWORT).fetchProfiles();
    if (result.kind !== "OK") throw new Error(result.kind);
    expect(result.profiles[1]?.links).toEqual([
      "https://sollife.live",
      "https://x.com/SolanaLifeX",
    ]);
  });

  it("meldet den Vertrag als geprueft", () => {
    const a = new DexScreenerProfilesAdapter({ clock });
    expect(a.contractVerified).toBe(true);
    expect(a.schemaVersion).toBe("dexscreener-token-profiles-v1@2026-09-06");
  });

  it("verwirft eine Adresse, die keine Solana-Adresse ist", async () => {
    // Eine als solana ausgezeichnete Zeile mit EVM-Adresse waere ein
    // Anbieterfehler — oder etwas Schlimmeres.
    const body = JSON.stringify([
      { chainId: "solana", tokenAddress: "0xD650972126b4384318D33Ab7433AC3C161427777" },
    ]);
    const result = await adapterWith(body).fetchProfiles();
    if (result.kind !== "OK") throw new Error(result.kind);
    expect(result.profiles).toHaveLength(0);
  });

  it("nimmt unbekannte Felder hin, statt den Strom anzuhalten", async () => {
    const body = JSON.stringify([
      { chainId: "solana", tokenAddress: "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump", neuesFeld: 1 },
    ]);
    expect((await adapterWith(body).fetchProfiles()).kind).toBe("OK");
  });

  it("lehnt eine Antwort ohne Pflichtfelder ab", async () => {
    const result = await adapterWith('[{"chainId":"solana"}]').fetchProfiles();
    expect(result.kind).toBe("SCHEMA_REJECTED");
  });

  it("lehnt ab, was kein JSON ist", async () => {
    expect((await adapterWith("<html>").fetchProfiles()).kind).toBe("SCHEMA_REJECTED");
  });

  it("ordnet HTTP-Fehler ein", async () => {
    const result = await adapterWith("nope", 429).fetchProfiles();
    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") expect(result.failure).toBe("RATE_LIMITED");
  });

  it("liefert bei leerem Strom keine Kandidaten und keinen Fehler", async () => {
    const result = await adapterWith("[]").fetchProfiles();
    expect(result.kind).toBe("OK");
    if (result.kind === "OK") expect(result.profiles).toHaveLength(0);
  });
});
