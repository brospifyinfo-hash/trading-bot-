import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDatabase } from "../../testing/index";
import type { Database } from "../../client";
import { tokens } from "../../schema/tokens";
import {
  TokenSeenStore,
  applyDiscoveryOutcomes,
  isTokenBlacklisted,
  selectTrackedTokens,
} from "../discovery";

/**
 * Die Datenbankseite der Entdeckung.
 *
 * Drei Zusicherungen, und jede von ihnen deckt einen Fehler ab, den man im
 * Betrieb erst merkt, wenn Geld daran haengt:
 *
 * 1. Der Speicher ist atomar — sonst legen zwei Laeufe denselben Token an.
 * 2. Ein bereits bewerteter Token faellt nicht auf den Anfang zurueck.
 * 3. Verworfene und gesperrte Tokens kosten kein Anbieterbudget mehr.
 */

const T0 = new Date("2026-09-06T09:00:00Z");
const MEME_A = "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump";
const MEME_B = "GSBZLSX8R8nq9qp2fs5oaLcQS72aG1SFEyuqbS1Apump";
const MEME_C = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

async function stateOf(mint: string): Promise<string | undefined> {
  const [row] = await db
    .select({ state: tokens.state })
    .from(tokens)
    .where(eq(tokens.mint, mint))
    .limit(1);
  return row?.state;
}

describe("Token-Speicher der Entdeckung", () => {
  it("legt einen unbekannten Mint an und meldet ihn als neu", async () => {
    const store = new TokenSeenStore(db, () => "dexscreener");
    expect(await store.has(MEME_A)).toBe(false);
    expect(await store.add(MEME_A, T0)).toBe(true);
    expect(await store.has(MEME_A)).toBe(true);
    expect(store.added).toEqual([MEME_A]);
  });

  it("meldet einen zweiten Versuch als nicht neu, ohne zu doppeln", async () => {
    // Der Unique-Index entscheidet, nicht die Anwendung: zwei Laeufe koennen
    // denselben Token gleichzeitig finden.
    const store = new TokenSeenStore(db, () => "andere-quelle");
    expect(await store.add(MEME_A, T0)).toBe(false);
    expect(store.added).toEqual([]);

    const rows = await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.mint, MEME_A));
    expect(rows).toHaveLength(1);
  });

  it("laesst die Dezimalstellen offen", async () => {
    // Sie stehen im Mint-Account, nicht in einer Marktdaten-Antwort. Eine
    // geratene Dezimalstelle waere im Ausfuehrungspfad ein Betragsfehler um
    // Zehnerpotenzen.
    const [row] = await db
      .select({ decimals: tokens.decimals })
      .from(tokens)
      .where(eq(tokens.mint, MEME_A))
      .limit(1);
    expect(row?.decimals).toBeNull();
  });
});

describe("Zustand nach dem Vorsieb", () => {
  it("schreibt Zustand, Herkunft, Symbol und Startzeit fest", async () => {
    const launched = new Date("2026-09-06T08:00:00Z");
    const updated = await applyDiscoveryOutcomes({
      db,
      outcomes: [
        {
          mint: MEME_A,
          state: "SCREENING",
          symbol: "MEMEA",
          launchedAt: launched,
          discoverySource: "dexscreener",
        },
      ],
    });
    expect(updated).toBe(1);

    const [row] = await db
      .select({
        state: tokens.state,
        symbol: tokens.symbol,
        launchedAt: tokens.launchedAt,
        source: tokens.discoverySource,
      })
      .from(tokens)
      .where(eq(tokens.mint, MEME_A))
      .limit(1);
    expect(row?.state).toBe("SCREENING");
    expect(row?.symbol).toBe("MEMEA");
    expect(row?.launchedAt).toEqual(launched);
    expect(row?.source).toBe("dexscreener");
  });

  it("wirft einen bereits weitergefuehrten Token nicht zurueck", async () => {
    // MEME_A steht auf SCREENING. Ein zweiter Fund darf ihn nicht erneut auf
    // SCREENING setzen und schon gar nicht auf REJECTED — er wuerde die Kette
    // von vorn durchlaufen und seine Bewertung verlieren.
    const updated = await applyDiscoveryOutcomes({
      db,
      outcomes: [
        {
          mint: MEME_A,
          state: "REJECTED",
          symbol: null,
          launchedAt: null,
          discoverySource: "dexscreener",
        },
      ],
    });
    expect(updated).toBe(0);
    expect(await stateOf(MEME_A)).toBe("SCREENING");
  });

  it("loescht ein bekanntes Symbol nicht mit einem fehlenden", async () => {
    await db.insert(tokens).values({ mint: MEME_B, discoverySource: "dexscreener", symbol: "B" });
    await applyDiscoveryOutcomes({
      db,
      outcomes: [
        {
          mint: MEME_B,
          state: "WATCHLIST",
          symbol: null,
          launchedAt: null,
          discoverySource: "dexscreener",
        },
      ],
    });
    const [row] = await db
      .select({ symbol: tokens.symbol, state: tokens.state })
      .from(tokens)
      .where(eq(tokens.mint, MEME_B))
      .limit(1);
    expect(row?.symbol).toBe("B");
    expect(row?.state).toBe("WATCHLIST");
  });
});

describe("Auswahl der abzufragenden Tokens", () => {
  it("laesst Verworfene und Gesperrte aus", async () => {
    await db
      .insert(tokens)
      .values({ mint: MEME_C, discoverySource: "dexscreener", state: "REJECTED" });
    await db
      .update(tokens)
      .set({ blacklistedAt: T0, blacklistReason: "TEST" })
      .where(eq(tokens.mint, MEME_B));

    const tracked = await selectTrackedTokens(db, 100);
    const mints = tracked.map((t) => t.mint);
    // MEME_A steht auf SCREENING und bleibt drin.
    expect(mints).toContain(MEME_A);
    // Beide Ausschluesse greifen — und zwar aus unterschiedlichen Gruenden.
    expect(mints).not.toContain(MEME_B);
    expect(mints).not.toContain(MEME_C);
  });

  it("kennt die Sperrliste", async () => {
    expect(await isTokenBlacklisted(db, MEME_B)).toBe(true);
    expect(await isTokenBlacklisted(db, MEME_A)).toBe(false);
    // Ein unbekannter Mint ist nicht gesperrt, sondern unbekannt.
    expect(await isTokenBlacklisted(db, "So11111111111111111111111111111111111111112")).toBe(false);
  });
});
