import { expect, it } from "vitest";
import { createTestDatabase } from "../../testing";
import { providerStatusSamples } from "../../schema/pipeline";
import { ProviderHealthStore } from "../provider-health";

it("selects only the latest status per provider in SQL", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = Date.parse("2026-09-30T00:00:00Z");
    await db.insert(providerStatusSamples).values(Array.from({ length: 100 }, (_, i) => ({
      providerId: i % 2 ? "jupiter" : "dexscreener", kind: "MARKET_DATA",
      status: i >= 98 ? "CONNECTED" as const : "UNAVAILABLE" as const,
      capabilities: ["TOKEN_MARKET"], observedAt: new Date(at + i * 1000),
    })));
    const store = new ProviderHealthStore(db);
    const rows = await store.latest();
    expect(rows.map((r) => [r.providerId, r.observedAt.getTime() - at, r.status]))
      .toEqual([["dexscreener", 98000, "CONNECTED"], ["jupiter", 99000, "CONNECTED"]]);
    expect(await store.anyMarketDataUsable()).toBe(true);
  } finally { await close(); }
}, 30000);
