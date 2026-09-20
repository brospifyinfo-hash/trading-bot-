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
