import { expect, it } from "vitest";
import { providerId } from "@sae/core";
import { schema } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import { buildHandlers } from "../../handlers";

it("refreshes all 20 active coins within five runs while preserving exploration inside the five-token budget", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date(Date.now() - 1000);
    const active = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const mint = "1".repeat(43) + "123456789ABCDEFGHJKLMNPQRSTUVWXYZ"[i]!;
      const [t] = await db.insert(schema.tokens).values({
        mint, discoverySource: "test", firstSeenAt: at,
      }).returning();
      if (i < 20) {
        active.add(mint);
        await db.insert(schema.tokenSnapshots).values({ tokenId: t!.id,
          observedAt: at, priceUsd: 1, marketCapUsd: 1000000, liquidityUsd: 100000,
          volume24hUsd: 50000, dataCompleteness: 1, sourceProviderId: "jupiter-quote" });
      }
    }
    const visited: string[] = [];
    const handler = buildHandlers({ db, logger: createLogger({ service: "test", level: "error" }),
      env: { PAPER_STRATEGY: "memecoin-risk-managed-v1", DEXSCREENER_BASE_URL: "https://api.example.invalid" },
      statusOf: () => "CONNECTED",
      adapters: new Map([["dexscreener", { providerId: providerId("dexscreener"), capabilities: ["TOKEN_MARKET"],
        fetchMarket: async (mint: string) => { visited.push(mint); return null; } }]]),
    }).REFRESH_MARKET_DATA!;
    for (let run = 0; run < 5; run++) {
      const result = await handler.handle({} as never) as { processed: number; activeTokens: number };
      expect(result.processed).toBe(5);
      expect(result.activeTokens).toBe(20);
    }
    expect(new Set(visited.filter((m) => active.has(m))).size).toBe(20);
    expect(new Set(visited.filter((m) => !active.has(m))).size).toBe(5);
  } finally { await close(); }
}, 30000);
