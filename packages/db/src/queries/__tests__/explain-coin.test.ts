import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { eur } from "@sae/core";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { opportunities } from "../../schema/opportunities";
import { strategies, strategyVersions, tokenPools, tokens, tokenSecurity, tokenSnapshots } from "../../schema/index";
import { DecisionRepository } from "../../repositories/decisions";
import { OpportunityRepository } from "../../repositories/opportunities";
import { PaperPositionRepository } from "../../repositories/paper-positions";
import { explainCoin, type CoinCheck, type CoinLimits } from "../explain-coin";

/**
 * „Warum hat er DIESEN Coin nicht gekauft?"
 *
 * Die Frage kam zweimal, und beide Male war die Antwort eine Vermutung. Dieser
 * Test haelt fest, dass die Auskunft an denselben Zahlen haengt wie die
 * Entscheidung — insbesondere, dass sie fuer BEIDE Modi stimmt. Eine Auskunft,
 * die im offensiven Modus die vorsichtigen Grenzen nennt, ist schlimmer als
 * keine: sie schickt den Betreiber hinter einen Grund, der gar nicht gilt.
 */

const NOW = new Date("2026-10-04T12:00:00Z");

const VORSICHTIG: CoinLimits = {
  maxMarketCapUsd: 5_000_000n,
  maxCoinAgeMinutes: null,
  minFinalScore: 50,
  mode: "VORSICHTIG",
};
const OFFENSIV: CoinLimits = { ...VORSICHTIG, mode: "OFFENSIV" };

let db: Database;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});

afterEach(async () => {
  await close();
});

/** Ein Coin, an dem nichts auszusetzen ist — die Messlatte fuer alles andere. */
async function sauberesToken(
  mint: string,
  snapshot: Record<string, unknown> = {},
  security: Record<string, unknown> | null = {},
  token: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await db
    .insert(tokens)
    .values({ mint, decimals: 9, discoverySource: "test", state: "SCREENING", ...token })
    .returning();
  const id = row!.id;
  await db.insert(tokenSnapshots).values({
    tokenId: id,
    observedAt: new Date(NOW.getTime() - 60_000),
    sourceProviderId: "dexscreener",
    sourceTier: "PRIMARY",
    priceUsd: 0.0001,
    liquidityUsd: 50_000,
    marketCapUsd: 2_000_000,
    volume24hUsd: 20_000,
    buys5m: 9,
    sells5m: 3,
    priceImpactBps: 40,
    exitCapacityRatio: 2.5,
    dataCompleteness: 1,
    ...snapshot,
  });
  if (security !== null) {
    await db.insert(tokenSecurity).values({
      tokenId: id,
      observedAt: new Date(NOW.getTime() - 60_000),
      checkVersion: "test-1",
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      lpBurnedOrLocked: true,
      riskLevel: "LOW",
      top10HolderSharePct: 30,
      ...security,
    });
  }
  return id;
}

const tor = (checks: readonly CoinCheck[], name: string): CoinCheck | undefined =>
  checks.find((c) => c.tor === name);
const blockiert = (checks: readonly CoinCheck[]): readonly string[] =>
  checks.filter((c) => c.verdict === "BLOCKIERT").map((c) => c.tor);

describe("Unbekannte Adresse", () => {
  it("sagt, dass die SUCHE den Coin nie gefunden hat — nicht, dass ein Tor zu war", async () => {
    const e = await explainCoin(db, "nie-gesehen", NOW, VORSICHTIG);

    expect(e.bekannt).toBe(false);
    expect(e.checks).toHaveLength(1);
    expect(e.checks[0]!.tor).toBe("NICHT_GEFUNDEN");
    expect(e.checks[0]!.verdict).toBe("BLOCKIERT");
    // Das ist die wichtigste Unterscheidung dieser Seite: keine Einstellung
    // der Welt haette diesen Coin gekauft.
    expect(e.checks[0]!.detail).toMatch(/Datenquellen/);
    expect(e.imSuchraum).toBe(false);
    expect(e.letzteEntscheidung).toBeNull();
  });
});

describe("Ein tadelloser Coin", () => {
  it("hat kein geschlossenes Tor und steht im Suchraum", async () => {
    await sauberesToken("sauber");
    const e = await explainCoin(db, "sauber", NOW, VORSICHTIG);

    expect(e.bekannt).toBe(true);
    expect(blockiert(e.checks)).toEqual([]);
    expect(e.imSuchraum).toBe(true);
    expect(e.imBudget).toBe(true);
    expect(e.offenePosition).toBe(false);
    expect(e.snapshotProvider).toBe("dexscreener");
  });
});

describe("Die Groessengrenze", () => {
  it("nennt den gemessenen Wert UND die eingestellte Grenze", async () => {
    await sauberesToken("zu-gross", { marketCapUsd: 900_000_000 });
    const e = await explainCoin(db, "zu-gross", NOW, VORSICHTIG);

    const groesse = tor(e.checks, "GROESSE");
    expect(groesse?.verdict).toBe("BLOCKIERT");
    expect(groesse?.detail).toContain("900.000.000");
    expect(groesse?.detail).toContain("5.000.000");
    // Und die Folge davon, die der Betreiber eigentlich wissen will.
    expect(tor(e.checks, "SUCHRAUM")?.verdict).toBe("BLOCKIERT");
    expect(e.imSuchraum).toBe(false);
  });

  it("bleibt im offensiven Modus genauso zu — die Groesse ist keine Wissenslucke", async () => {
    await sauberesToken("zu-gross-offensiv", { marketCapUsd: 900_000_000 });
    const e = await explainCoin(db, "zu-gross-offensiv", NOW, OFFENSIV);

    expect(tor(e.checks, "GROESSE")?.verdict).toBe("BLOCKIERT");
  });

  it("laesst ihn durch, wenn der Betreiber die Grenze hochsetzt", async () => {
    await sauberesToken("gross-erlaubt", { marketCapUsd: 900_000_000 });
    const e = await explainCoin(db, "gross-erlaubt", NOW, {
      ...VORSICHTIG,
      maxMarketCapUsd: 1_000_000_000n,
    });

    expect(tor(e.checks, "GROESSE")?.verdict).toBe("OK");
    expect(e.imSuchraum).toBe(true);
  });
});

describe("Das Alter", () => {
  it("nennt unbekannte Entstehungszeit als Ausschluss in BEIDEN Modi", async () => {
    await sauberesToken("ohne-alter");
    for (const limits of [VORSICHTIG, OFFENSIV]) {
      const e = await explainCoin(db, "ohne-alter", NOW, { ...limits, maxCoinAgeMinutes: 60 });
      const alter = tor(e.checks, "ALTER");
      expect(alter?.verdict).toBe("BLOCKIERT");
      expect(alter?.detail).toMatch(/unbekannt/);
      expect(e.imSuchraum).toBe(false);
    }
  });

  it("vergleicht gegen die Entstehungszeit des Pools, nicht gegen den Erstkontakt", async () => {
    await sauberesToken("zu-alt", {}, {}, {
      launchedAt: new Date(NOW.getTime() - 10 * 86_400_000),
      firstSeenAt: new Date(NOW.getTime() - 60_000),
    });
    const e = await explainCoin(db, "zu-alt", NOW, { ...VORSICHTIG, maxCoinAgeMinutes: 60 });

    expect(tor(e.checks, "ALTER")?.verdict).toBe("BLOCKIERT");
    expect(tor(e.checks, "ALTER")?.detail).toContain("14400");
  });

  it("sagt klar, wenn gar keine Altersgrenze gesetzt ist", async () => {
    await sauberesToken("alt-egal", {}, {}, {
      launchedAt: new Date(NOW.getTime() - 10 * 86_400_000),
    });
    const e = await explainCoin(db, "alt-egal", NOW, VORSICHTIG);

    expect(tor(e.checks, "ALTER")?.verdict).toBe("OK");
    expect(e.imSuchraum).toBe(true);
  });
});

describe("Was der Modus aendert und was nicht", () => {
  it("behandelt fehlende Ausfuehrungsdaten vorsichtig als Ausschluss, offensiv nicht", async () => {
    await sauberesToken("ohne-router", { priceImpactBps: null, exitCapacityRatio: null });

    const streng = await explainCoin(db, "ohne-router", NOW, VORSICHTIG);
    expect(tor(streng.checks, "PREISEINFLUSS")?.verdict).toBe("BLOCKIERT");
    expect(tor(streng.checks, "AUSSTIEGSFAEHIGKEIT")?.verdict).toBe("BLOCKIERT");

    const frei = await explainCoin(db, "ohne-router", NOW, OFFENSIV);
    expect(tor(frei.checks, "PREISEINFLUSS")?.verdict).toBe("UNBEKANNT");
    expect(tor(frei.checks, "AUSSTIEGSFAEHIGKEIT")?.verdict).toBe("UNBEKANNT");
    // Offensiv ist das Tor offen — es bleibt aber sichtbar, dass die Zahl fehlt.
    expect(blockiert(frei.checks)).toEqual([]);
  });

  it("nennt die Halterkonzentration gegen die Grenze DES MODUS", async () => {
    await sauberesToken("konzentriert", {}, { top10HolderSharePct: 80 });

    const streng = tor((await explainCoin(db, "konzentriert", NOW, VORSICHTIG)).checks,
      "HALTERKONZENTRATION");
    expect(streng?.verdict).toBe("BLOCKIERT");
    expect(streng?.detail).toContain("60");

    const frei = tor((await explainCoin(db, "konzentriert", NOW, OFFENSIV)).checks,
      "HALTERKONZENTRATION");
    expect(frei?.verdict).toBe("OK");
    expect(frei?.detail).toContain("100");
  });

  it("laesst einen BEFUND auch offensiv nicht durch", async () => {
    await sauberesToken("mint-offen", {}, { mintAuthorityActive: true });
    const e = await explainCoin(db, "mint-offen", NOW, OFFENSIV);

    const befund = e.checks.find((c) => c.tor === "SICHERHEIT" && c.verdict === "BLOCKIERT");
    expect(befund?.detail).toMatch(/Mint-Autoritaet aktiv: ja/);
    expect(befund?.detail).toMatch(/auch im offensiven Modus/);
  });

  it("blockiert CRITICAL in beiden Modi", async () => {
    await sauberesToken("kritisch", {}, { riskLevel: "CRITICAL" });
    for (const limits of [VORSICHTIG, OFFENSIV]) {
      const e = await explainCoin(db, "kritisch", NOW, limits);
      expect(tor(e.checks, "RISIKOSTUFE")?.verdict).toBe("BLOCKIERT");
    }
  });

  it("haelt die Liquiditaetsgrenze des Suchraums in BEIDEN Modi — sie ist nicht einstellbar", async () => {
    await sauberesToken("duenn", { liquidityUsd: 900 });
    for (const limits of [VORSICHTIG, OFFENSIV]) {
      const e = await explainCoin(db, "duenn", NOW, limits);
      const liq = tor(e.checks, "LIQUIDITAET");
      expect(liq?.verdict).toBe("BLOCKIERT");
      expect(liq?.detail).toContain("5.000");
      expect(liq?.detail).toMatch(/BEIDEN Modi/);
    }
  });
});

describe("Veraltete und fehlende Marktdaten", () => {
  it("unterscheidet nie gemessen von zu lange her", async () => {
    const [ohne] = await db
      .insert(tokens)
      .values({ mint: "ohne-daten", discoverySource: "test", state: "SCREENING" })
      .returning();
    expect(ohne).toBeDefined();
    const leer = await explainCoin(db, "ohne-daten", NOW, VORSICHTIG);
    expect(tor(leer.checks, "KEINE_MARKTDATEN")?.verdict).toBe("BLOCKIERT");
    expect(tor(leer.checks, "MARKTDATEN_FRISCH")).toBeUndefined();

    await sauberesToken("veraltet", { observedAt: new Date(NOW.getTime() - 9 * 3_600_000) });
    const alt = await explainCoin(db, "veraltet", NOW, VORSICHTIG);
    expect(tor(alt.checks, "MARKTDATEN_FRISCH")?.verdict).toBe("BLOCKIERT");
    expect(tor(alt.checks, "MARKTDATEN_FRISCH")?.detail).toContain("9.0 Stunden");
  });
});

describe("Sperre", () => {
  it("nennt Zeitpunkt und Grund und sagt, dass es endgueltig ist", async () => {
    await sauberesToken("gesperrt", {}, {}, {
      blacklistedAt: new Date(NOW.getTime() - 3_600_000),
      blacklistReason: "Honeypot",
    });
    const e = await explainCoin(db, "gesperrt", NOW, OFFENSIV);

    const sperre = tor(e.checks, "GESPERRT");
    expect(sperre?.verdict).toBe("BLOCKIERT");
    expect(sperre?.detail).toContain("Honeypot");
    expect(sperre?.detail).toMatch(/endgueltig/);
    expect(e.imSuchraum).toBe(false);
  });
});

describe("Die Adresse aus einem DexScreener-Link", () => {
  it("findet den Coin auch ueber die Adresse des HANDELSPAARS", async () => {
    const tokenId = await sauberesToken("echter-mint");
    await db.insert(tokenPools).values({
      tokenId, address: "paar-adresse", dex: "raydium",
      baseMint: "echter-mint", quoteMint: "So11111111111111111111111111111111111111112",
      feeBps: 25, observedAt: new Date(NOW.getTime() - 60_000),
    });

    const e = await explainCoin(db, "paar-adresse", NOW, OFFENSIV);

    // Formal „nicht gefunden" waere hier richtig und praktisch eine
    // Falschauskunft: der Link, den man kopiert, traegt die Paar-Adresse.
    expect(e.bekannt).toBe(true);
    expect(e.gefundenUeber).toBe("HANDELSPAAR");
    expect(e.gesucht).toBe("paar-adresse");
    expect(e.mint).toBe("echter-mint");
  });

  it("nennt beim Alter einen Uebertragungsfehler bei uns, wenn das Paar die Zeit kennt", async () => {
    const tokenId = await sauberesToken("zeit-nur-am-paar");
    await db.insert(tokenPools).values({
      tokenId, address: "paar-mit-zeit", dex: "raydium",
      baseMint: "zeit-nur-am-paar", quoteMint: "So11111111111111111111111111111111111111112",
      feeBps: 25, observedAt: new Date(NOW.getTime() - 60_000),
      createdAt: new Date(NOW.getTime() - 30 * 60_000),
    });

    const e = await explainCoin(db, "zeit-nur-am-paar", NOW, {
      ...OFFENSIV, maxCoinAgeMinutes: 60,
    });

    const alter = tor(e.checks, "ALTER");
    expect(alter?.verdict).toBe("BLOCKIERT");
    expect(alter?.detail).toMatch(/Uebertragungsfehler bei uns/);
  });
});

describe("Das Budget je Lauf", () => {
  it("trennt faellt-durch-die-Filter von kommt-nicht-dran", async () => {
    // 20 Coins mit Kaufdruck, einer ohne. Sortiert wird nach Kaufdruck
    // zuerst — der ohne liegt also auf Platz 21 und wird nie geprueft,
    // obwohl er jeden Filter passiert.
    for (let i = 0; i < 20; i++) await sauberesToken(`gedraengt-${String(i)}`);
    await sauberesToken("hinten", { buys5m: 0, sells5m: 0 });

    const e = await explainCoin(db, "hinten", NOW, OFFENSIV);
    expect(e.imSuchraum).toBe(true);
    expect(e.imBudget).toBe(false);
    expect(tor(e.checks, "SUCHRAUM")?.verdict).toBe("OK");
    expect(tor(e.checks, "BUDGET")?.verdict).toBe("BLOCKIERT");
    expect(tor(e.checks, "BUDGET")?.detail).toMatch(/kommt nicht dran/);
  }, 60_000);
});

describe("Was der Bot selbst notiert hat", () => {
  it("zeigt die letzte Entscheidung, ihre Gruende und die offene Position", async () => {
    const tokenId = await sauberesToken("notiert");
    const [strategy] = await db.insert(strategies).values({ name: "erklaerung" }).returning();
    const [version] = await db
      .insert(strategyVersions)
      .values({
        strategyId: strategy!.id, version: "1.0.0", parameters: {},
        reason: "Test der Erklaerseite",
      })
      .returning();
    const strategyVersionId = version!.id;

    const created = await new OpportunityRepository(db).create({
      tokenId,
      stream: "AUTO_PAPER",
      decisionKind: "ENTER",
      finalScore: 20,
      reasons: ["Kaufdruck vorhanden"],
      risks: [],
      rejectionReasons: ["BLOCKED_DATA_QUALITY_TOO_LOW"],
      strategyVersionId,
      decidedAt: new Date(NOW.getTime() - 120_000),
      respondBy: null,
      provenance: {
        sourceType: "LIVE",
        sourceProvider: "dexscreener",
        sourceTier: "PRIMARY",
        sourceTimestamp: new Date(NOW.getTime() - 120_000),
        dataTimestamp: new Date(NOW.getTime() - 120_000),
        decisionTimestamp: new Date(NOW.getTime() - 120_000),
        dataQuality: 0.9,
      },
      snapshot: {
        tokenId,
        observedAt: new Date(NOW.getTime() - 120_000),
        features: { liquidityUsd: 50_000 },
        missingFields: [],
        dataCompleteness: 0.9,
        scoreEngineVersion: "1.0.0",
        featureSetVersion: "1",
        inputHash: "hash-erklaerung",
      },
    });
    if (created.kind !== "CREATED") throw new Error("Vorbedingung");

    const [gelegenheit] = await db
      .select({ snapshotId: opportunities.featureSnapshotId })
      .from(opportunities)
      .where(eq(opportunities.id, created.opportunityId));

    await new DecisionRepository(db).create({
      decisionKey: "erklaerung-1",
      tokenId,
      decidedAt: new Date(NOW.getTime() - 120_000),
      strategyVersionId,
      scoreEngineVersion: "1.0.0",
      decisionKind: "ENTER",
      finalScore: 20,
      dataCompleteness: 0.9,
      featureSnapshotId: gelegenheit!.snapshotId,
      provenance: {
        sourceType: "LIVE",
        sourceProvider: "dexscreener",
        sourceTier: "PRIMARY",
        sourceTimestamp: new Date(NOW.getTime() - 120_000),
        dataTimestamp: new Date(NOW.getTime() - 120_000),
        decisionTimestamp: new Date(NOW.getTime() - 120_000),
        dataQuality: 0.9,
      },
    });

    const opened = await new PaperPositionRepository(db).open({
      opportunityId: created.opportunityId,
      tokenId,
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId,
      openedAt: new Date(NOW.getTime() - 60_000),
      fromState: "OFFERED",
      sourceType: "LIVE",
      entryCostsMinor: 0n,
    });
    if (opened.kind !== "OPENED") throw new Error("Vorbedingung");

    const e = await explainCoin(db, "notiert", NOW, VORSICHTIG);

    expect(e.letzteEntscheidung?.kind).toBe("ENTER");
    expect(e.letzteEntscheidung?.finalScore).toBe(20);
    expect(e.notierteGruende?.gruende).toContain("BLOCKED_DATA_QUALITY_TOO_LOW");
    expect(e.notierteGruende?.gruende).toContain("Kaufdruck vorhanden");

    // Score 20 gegen Schwelle 50: das Tor benennt beide Zahlen.
    const schwelle = tor(e.checks, "SCHWELLE");
    expect(schwelle?.verdict).toBe("BLOCKIERT");
    expect(schwelle?.detail).toContain("20");
    expect(schwelle?.detail).toContain("50");

    expect(e.offenePosition).toBe(true);
    expect(tor(e.checks, "SCHON_IM_BESTAND")?.verdict).toBe("BLOCKIERT");
  }, 60_000);
});
