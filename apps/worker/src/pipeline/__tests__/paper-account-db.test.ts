import { expect, it } from "vitest";
import { eur } from "@sae/core";
import { PaperPositionRepository, schema } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { loadPaperAccount } from "../paper-account";

it("reconciles repository fills across versions while separating fixtures, manual and fixed sizing", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-09-14T12:00:00Z");
    const [token] = await db.insert(schema.tokens).values({ mint: "account-test-mint", discoverySource: "test" }).returning();
    const [strategy] = await db.insert(schema.strategies).values({ name: "account-test" }).returning();
    const [other] = await db.insert(schema.strategies).values({ name: "other-account" }).returning();
    const versions = await db.insert(schema.strategyVersions).values([
      { strategyId: strategy!.id, version: "1", parameters: {}, reason: "fixture" },
      { strategyId: strategy!.id, version: "2", parameters: {}, reason: "fixture" },
      { strategyId: other!.id, version: "1", parameters: {}, reason: "fixture" },
    ]).returning();
    const repo = new PaperPositionRepository(db);
    const positions: string[] = [];
    for (let index = 0; index < 6; index++) {
      const sourceType = index === 2 ? "TEST_FIXTURE" : "LIVE";
      const stream = index === 3 ? "MANUAL_PAPER" : "AUTO_PAPER";
      const version = versions[index === 5 ? 2 : index === 1 ? 1 : 0]!;
      const [feature] = await db.insert(schema.featureSnapshots).values({
        tokenId: token!.id, observedAt: at, features: {}, dataCompleteness: 1,
        sourceType, isTestFixture: sourceType === "TEST_FIXTURE", sourceProvider: "TEST_FIXTURE:account",
        scoreEngineVersion: `fixture-${index}`, featureSetVersion: "1", inputHash: `account-${index}`,
      }).returning();
      const [opportunity] = await db.insert(schema.opportunities).values({
        tokenId: token!.id, strategyVersionId: version.id, featureSnapshotId: feature!.id,
        stream, state: "OFFERED", decisionKind: "ENTER", decidedAt: new Date(at.getTime() - index),
        sourceType, isTestFixture: sourceType === "TEST_FIXTURE",
      }).returning();
      const opened = await repo.open({ opportunityId: opportunity!.id, tokenId: token!.id,
        strategyVersionId: version.id, stream, sizingMode: index === 4 ? "FIXED_100" : "RISK_BASED",
        entryNotional: eur(100.01), entryAmountRaw: 3n, entryCostsMinor: 100n,
        openedAt: at, fromState: "OFFERED", sourceType,
      });
      if (opened.kind !== "OPENED") throw new Error("Fixture failed");
      positions.push(opened.positionId);
    }
    await repo.settleSale({ positionId: positions[0]!, expectedVersion: 0, soldAmountRaw: 1n,
      proceeds: eur(50), costs: eur(.20), at, reason: "fixture", levelIndex: 1,
      maxAdverseExcursion: 0, maxFavorableExcursion: 0, valuation: { source: "TEST_FIXTURE" },
    });
    const account = await loadPaperAccount({ db, strategyId: strategy!.id, initialCash: eur(3000), asOf: at });
    expect(account.kind).toBe("READY");
    if (account.kind !== "READY") return;
    expect(account.cash).toEqual(eur(2847.78));
    expect(account.portfolio.openPositions).toHaveLength(2);
    expect(account.portfolio.openPositions.reduce((sum, row) => sum + row.notional.minor, 0n)).toBe(16669n);
  } finally { await close(); }
}, 30_000);
