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
