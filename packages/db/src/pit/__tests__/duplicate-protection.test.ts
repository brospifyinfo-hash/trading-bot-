import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../client";
import { strategies, strategyVersions, tokens, tradeIntents } from "../../schema/index";
import { createTestDatabase } from "./harness";

/**
 * Doppelte Trades auf denselben Token.
 *
 * Die Anwendungslogik prueft das ebenfalls, aber Anwendungslogik hat Race
 * Conditions: zwei Worker koennen im selben Moment zum selben Schluss kommen.
 * Der partielle Unique-Index ist die Ebene, an der die Datenbank es unmoeglich
 * macht — unabhaengig davon, wie viele Prozesse gleichzeitig laufen.
 */

const MINT = "So11111111111111111111111111111111111111112";

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;

const intent = (overrides: Partial<typeof tradeIntents.$inferInsert> = {}) => ({
  tokenId,
  mint: MINT,
  mode: "live" as const,
  origin: "auto" as const,
  side: "buy" as const,
  idempotencyKey: `key-${Math.random()}`,
  plannedNotionalMinor: 10_000n,
  currency: "EUR" as const,
  maxSlippageBps: 300,
  strategyVersionId,
  expiresAt: new Date(Date.now() + 900_000),
  ...overrides,
});

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;

  const [strategy] = await db.insert(strategies).values({ name: "test" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({
      strategyId: strategy!.id,
      version: "1.0.0",
      parameters: {},
      reason: "Testfixture fuer den Duplikatschutz",
    })
    .returning();
  strategyVersionId = version!.id;
});

afterAll(async () => {
  await close();
});

describe("Duplikatschutz auf Datenbankebene", () => {
  it("erlaubt einen aktiven Intent pro Token und Modus", async () => {
    await expect(db.insert(tradeIntents).values(intent())).resolves.toBeDefined();
  });

  it("verhindert einen zweiten aktiven Intent auf denselben Token", async () => {
    // Der Fall, der ohne Index passiert: zwei Worker kaufen gleichzeitig.
    await expect(db.insert(tradeIntents).values(intent())).rejects.toThrow(/unique|duplicate/i);
  });

  it("trennt Paper und Live", async () => {
    // Ein laufender Paper-Trade darf einen Live-Trade nicht blockieren.
    await expect(db.insert(tradeIntents).values(intent({ mode: "paper" }))).resolves.toBeDefined();
  });

  it("gibt den Token nach Abschluss wieder frei", async () => {
    await db.update(tradeIntents).set({ state: "CLOSED" });
    await expect(db.insert(tradeIntents).values(intent())).resolves.toBeDefined();
  });

  it("blockiert weiterhin, solange ein Intent UNKNOWN ist", async () => {
    // Eine gesendete, aber unbestaetigte Transaktion haelt den Token besetzt.
    // Sonst kauft das System nach einem RPC-Timeout ein zweites Mal.
    await db.update(tradeIntents).set({ state: "CLOSED" });
    await db.insert(tradeIntents).values(intent({ state: "UNKNOWN" }));
    await expect(db.insert(tradeIntents).values(intent())).rejects.toThrow(/unique|duplicate/i);
  });

  it("weist einen wiederverwendeten Idempotenzschluessel zurueck", async () => {
    await db.update(tradeIntents).set({ state: "CLOSED" });
    const key = "stabiler-schluessel";
    await db.insert(tradeIntents).values(intent({ idempotencyKey: key }));
    await db.update(tradeIntents).set({ state: "CLOSED" });
    await expect(
      db.insert(tradeIntents).values(intent({ idempotencyKey: key })),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
