import { expect, it, vi } from "vitest";
import { tokenId } from "@sae/core";
import type { PitReader, PitSnapshot } from "@sae/db";
import { buildFeatureVector } from "../feature-build";

it("scores the current acquisition, never replacing missing current fields with older values", async () => {
  const now = new Date("2026-10-01T08:00:00Z"), id = tokenId("current-token");
  const current: PitSnapshot = { tokenId: id, observedAt: now, sourceProviderId: "jupiter-quote",
    sourceFreshnessSeconds: 1, priceUsd: 2, liquidityUsd: null, marketCapUsd: 100000,
    volume24hUsd: 5000, volume5mUsd: 1000, buys5m: 20, sells5m: 10,
    priceImpactBps: 50, exitCapacityRatio: 5, holders: null, finalScore: null,
    dataCompleteness: 0, scoreEngineVersion: null };
  const previous = { ...current, observedAt: new Date(now.getTime() - 300000),
    priceUsd: 1, liquidityUsd: 10000, buys5m: 0 };
  const pit: PitReader = { mode: "live", snapshotAt: vi.fn(async () => previous),
    snapshotsBetween: async () => [previous], securityAt: async () => null,
    smartMoneyQualifiedAt: async () => [] };
  const value = await buildFeatureVector({ pit, tokenId: id, asOf: now, firstSeenAt: null, currentSnapshot: current });
  expect(pit.snapshotAt).not.toHaveBeenCalled();
  expect(value?.momentum.buys5m).toMatchObject({ kind: "OBSERVED", value: 20 });
  expect(value?.market.liquidityUsd.kind).toBe("MISSING");
  expect(value?.momentum.priceChange5m).toMatchObject({ kind: "OBSERVED", value: 1 });
  expect(await buildFeatureVector({ pit, tokenId: id, asOf: new Date(now.getTime()-1), firstSeenAt: null, currentSnapshot: current })).toBeNull();
});
