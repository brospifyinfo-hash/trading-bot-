import { expect, it } from "vitest";
import { createTestDatabase } from "../../testing/index";
import { tokens, tokenSnapshots } from "../../schema/tokens";
import { selectActivePaperTokens, selectTokensNeedingSecurity } from "../discovery";

it("focuses on usable observed markets, excluding stale, future, fixture, blacklisted and deteriorated data", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const now = new Date("2026-09-20T12:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const [t] = await db.insert(tokens).values({ mint: "active-" + i, discoverySource: "test",
        firstSeenAt: new Date(now.getTime() + i), ...(i === 5 ? { blacklistedAt: now } : {}) }).returning();
      ids.push(t!.id);
      await db.insert(tokenSnapshots).values({ tokenId: t!.id,
        observedAt: new Date(now.getTime() + (i === 2 ? 1000 : i === 3 ? -7 * 3600000 : -1000)),
        sourceProviderId: i === 4 ? "TEST_FIXTURE:market" : "jupiter-quote",
        priceUsd: 1, liquidityUsd: i === 1 ? 100 : 100000, marketCapUsd: 1000000, volume24hUsd: 50000,
        dataCompleteness: 1 });
    }
    await db.insert(tokenSnapshots).values({ tokenId: ids[6]!, observedAt: now,
      sourceProviderId: "jupiter-quote", priceUsd: 1, liquidityUsd: 1, marketCapUsd: 1000000, volume24hUsd: 50000, dataCompleteness: 1 });
    const active = await selectActivePaperTokens(db, now);
    expect(active.map((r) => r.id)).toEqual([ids[0]]);
    expect(active[0]!.firstSeenAt).toBeInstanceOf(Date);
    const security = await selectTokensNeedingSecurity(db, 1, now, [ids[0]!]);
    expect(security[0]!.id).toBe(ids[0]);
  } finally { await close(); }
}, 30000);

/**
 * Der Suchraum: Groesse und Alter.
 *
 * Der Betreiber fand Einstiege in grosse Coins. Der Deckel stand an drei
 * Stellen getrennt — als Literal im SQL dieser Abfrage, und zweimal in den
 * Profilen —, und im Offensiv-Modus war er ganz offen. Jetzt kommt EINE Zahl
 * aus den Einstellungen und gilt hier und am Einstiegstor.
 */
it("beachtet Groessengrenze und Hoechstalter aus den Einstellungen", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const now = new Date("2026-10-02T12:00:00Z");
    const anlegen = async (mint: string, cap: number, launchedAt: Date | null) => {
      const [token] = await db.insert(tokens).values({
        mint, discoverySource: "test", state: "SCREENING",
        ...(launchedAt === null ? {} : { launchedAt }),
      }).returning();
      await db.insert(tokenSnapshots).values({
        tokenId: token!.id, observedAt: new Date(now.getTime() - 60_000),
        sourceProviderId: "dexscreener", sourceTier: "PRIMARY",
        priceUsd: 0.001, liquidityUsd: 50_000, marketCapUsd: cap, volume24hUsd: 20_000,
        dataCompleteness: 1,
      });
      return token!.id;
    };

    const klein = await anlegen("klein-neu", 2_000_000, new Date(now.getTime() - 5 * 60_000));
    const gross = await anlegen("gross-neu", 900_000_000, new Date(now.getTime() - 5 * 60_000));
    const altKlein = await anlegen("klein-alt", 2_000_000, new Date(now.getTime() - 10 * 86_400_000));
    const unbekannt = await anlegen("klein-ohne-alter", 2_000_000, null);

    // Ohne Angaben: die kleine Voreinstellung greift, der grosse Coin ist
    // draussen — das war der eigentliche Fehler.
    const ohne = await selectActivePaperTokens(db, now);
    expect(ohne.map((t) => t.id)).not.toContain(gross);
    expect(ohne.map((t) => t.id)).toContain(klein);

    // Eine hoehere Grenze laesst ihn herein. Die Zahl wirkt also wirklich.
    const hoch = await selectActivePaperTokens(db, now, 20, false, {
      maxMarketCapUsd: 1_000_000_000n,
    });
    expect(hoch.map((t) => t.id)).toContain(gross);

    // Mit Hoechstalter: nur der neue kleine. Der alte faellt heraus, und der
    // mit UNBEKANNTER Entstehungszeit ebenfalls — „ich weiss nicht, wie alt
    // er ist" ist bei „nur neue" kein Durchlassgrund.
    const neu = await selectActivePaperTokens(db, now, 20, false, { maxCoinAgeMinutes: 60 });
    expect(neu.map((t) => t.id)).toContain(klein);
    expect(neu.map((t) => t.id)).not.toContain(altKlein);
    expect(neu.map((t) => t.id)).not.toContain(unbekannt);

    // Ohne Altersgrenze sind beide wieder dabei.
    const alle = await selectActivePaperTokens(db, now);
    expect(alle.map((t) => t.id)).toContain(altKlein);
    expect(alle.map((t) => t.id)).toContain(unbekannt);
  } finally { await close(); }
}, 60_000);

/**
 * Warum ein Coin NICHT im Suchraum ist.
 *
 * Die Gegenprobe zum Filter: jede Ablehnung muss einen Namen haben. Steht
 * `beobachtet` auf 0, soll diese Auszaehlung sagen, woran es liegt — sonst
 * sieht eine richtige Leere genauso aus wie ein kaputter Bot, und das ist in
 * diesem Projekt schon dreimal passiert (§140, §144, §145).
 */
it("nennt fuer jeden bekannten Coin den Grund, warum er draussen ist", async () => {
  const { countUniverseExclusions } = await import("../../queries/universe");
  const { db, close } = await createTestDatabase();
  try {
    const now = new Date("2026-10-03T12:00:00Z");
    const anlegen = async (
      mint: string,
      snapshot: Record<string, unknown> | null,
      over: Record<string, unknown> = {},
    ) => {
      const [token] = await db.insert(tokens).values({
        mint, discoverySource: "test", state: "SCREENING", ...over,
      }).returning();
      if (snapshot !== null) {
        await db.insert(tokenSnapshots).values({
          tokenId: token!.id, observedAt: new Date(now.getTime() - 60_000),
          sourceProviderId: "dexscreener", sourceTier: "PRIMARY", dataCompleteness: 1,
          priceUsd: 0.001, liquidityUsd: 50_000, marketCapUsd: 2_000_000,
          volume24hUsd: 20_000, ...snapshot,
        });
      }
      return token!.id;
    };

    const neu = new Date(now.getTime() - 5 * 60_000);
    await anlegen("u-ok", {}, { launchedAt: neu });
    await anlegen("u-gesperrt", {}, { blacklistedAt: now, launchedAt: neu });
    await anlegen("u-keine-daten", null, { launchedAt: neu });
    await anlegen("u-duenn", { liquidityUsd: 100 }, { launchedAt: neu });
    await anlegen("u-gross", { marketCapUsd: 900_000_000 }, { launchedAt: neu });
    await anlegen("u-ohne-alter", {}, {});
    await anlegen("u-alt", {}, { launchedAt: new Date(now.getTime() - 10 * 86_400_000) });

    const gruende = await countUniverseExclusions(db, now, {
      maxMarketCapUsd: 5_000_000n, maxCoinAgeMinutes: 60,
    });

    expect(gruende["OK"]).toBe(1);
    expect(gruende["GESPERRT"]).toBe(1);
    expect(gruende["KEINE_AKTUELLEN_DATEN"]).toBe(1);
    expect(gruende["ZU_WENIG_LIQUIDITAET"]).toBe(1);
    expect(gruende["ZU_GROSS"]).toBe(1);
    expect(gruende["ALTER_UNBEKANNT"]).toBe(1);
    expect(gruende["ZU_ALT"]).toBe(1);

    // Jeder bekannte Coin steht in genau einem Topf. Eine Auszaehlung, die
    // nicht aufgeht, laedt dazu ein, die Luecke fuer einen eigenen Grund zu
    // halten.
    const summe = Object.values(gruende).reduce((n, x) => n + x, 0);
    expect(summe).toBe(7);

    // Ohne Altersgrenze wandern die beiden Alters-Faelle nach OK.
    const ohneAlter = await countUniverseExclusions(db, now, { maxMarketCapUsd: 5_000_000n });
    expect(ohneAlter["OK"]).toBe(3);
    expect(ohneAlter["ALTER_UNBEKANNT"]).toBeUndefined();
    expect(ohneAlter["ZU_ALT"]).toBeUndefined();

    // Und die Auszaehlung stimmt mit dem Filter ueberein: so viele OK, so
    // viele in der Liste. Zwei Zahlen, die auseinanderlaufen koennen, waeren
    // schlimmer als eine.
    const liste = await selectActivePaperTokens(db, now, 20, false, {
      maxMarketCapUsd: 5_000_000n, maxCoinAgeMinutes: 60,
    });
    expect(liste).toHaveLength(gruende["OK"] ?? 0);
  } finally { await close(); }
}, 60_000);

/**
 * Die Entstehungszeit nachtragen.
 *
 * Ohne dieses Nachtragen ist die Altersgrenze aus §149 eine Falle:
 * `launched_at` wird nur beim Uebergang aus dem Zustand `DISCOVERED`
 * geschrieben, und fehlte die Zeit dort, bleibt sie dauerhaft leer — der Coin
 * faellt bei gesetzter Grenze fuer immer heraus, obwohl der Anbieter die Zeit
 * bei jedem Marktdaten-Abruf mitschickt.
 */
it("traegt fehlende Entstehungszeiten nach, ohne vorhandene zu ueberschreiben", async () => {
  const { backfillLaunchedAt } = await import("../discovery");
  const { db, close } = await createTestDatabase();
  try {
    const now = new Date("2026-10-03T12:00:00Z");
    const neu = new Date(now.getTime() - 5 * 60_000);
    const alt = new Date(now.getTime() - 10 * 86_400_000);

    await db.insert(tokens).values([
      { mint: "b-leer", discoverySource: "test" },
      { mint: "b-vorhanden", discoverySource: "test", launchedAt: alt },
    ]);

    const geschrieben = await backfillLaunchedAt(db, [
      { mint: "b-leer", createdAt: neu },
      // Vorhandener Wert: wird NICHT ueberschrieben. Die Entstehungszeit
      // eines Pools aendert sich nicht, und ein abweichender zweiter Wert
      // waere ein Hinweis auf einen anderen Pool, kein Grund zum Verwerfen.
      { mint: "b-vorhanden", createdAt: neu },
      // Zukunft: abgewiesen. Eingetragen wuerde sie jede Altersrechnung
      // verdrehen.
      { mint: "b-leer", createdAt: new Date(now.getTime() + 86_400_000) },
      // Unbekannter Mint: kein Fehler, nur keine Zeile.
      { mint: "b-gibt-es-nicht", createdAt: neu },
    ], now);

    expect(geschrieben).toBe(1);
    const zeilen = await db.select({ mint: tokens.mint, launchedAt: tokens.launchedAt })
      .from(tokens);
    expect(zeilen.find((z) => z.mint === "b-leer")?.launchedAt).toEqual(neu);
    expect(zeilen.find((z) => z.mint === "b-vorhanden")?.launchedAt).toEqual(alt);

    // Zweiter Durchlauf aendert nichts mehr.
    expect(await backfillLaunchedAt(db, [{ mint: "b-leer", createdAt: alt }], now)).toBe(0);
  } finally { await close(); }
}, 60_000);
