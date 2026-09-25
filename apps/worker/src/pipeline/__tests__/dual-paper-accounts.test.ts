import { expect, it } from "vitest";
import { eur, strategyVersionId } from "@sae/core";
import { PAPER_PROFILES, MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { schema, OpportunityRepository, PaperPositionRepository, loadPaperTrading } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { ensurePaperCandidateVersion } from "../paper-candidate-version";

it("keeps the deployed Standard rules and independent account ledgers for simultaneous decisions", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-09-20T12:00:00Z");
    expect(MEMECOIN_PAPER_CANDIDATE.version).toBe("1.0.0");
    expect(MEMECOIN_PAPER_CANDIDATE.parameters.entryGates).toMatchObject({ minFinalScore: 75, minMomentumScore: 60, maxMarketCapUsd: 5_000_000 });
    expect(MEMECOIN_PAPER_CANDIDATE.parameters.risk).toMatchObject({ riskPerTradePct: .5, maxPositionPct: 3, maxPortfolioExposurePct: 10, maxDailyLossPct: 3, maxOpenPositions: 4 });
    const versions = [];
    for (const profile of PAPER_PROFILES) versions.push(await ensurePaperCandidateVersion(db, at, profile.candidate));
    expect(versions[0]!.id).not.toBe(versions[1]!.id);
    const [token] = await db.insert(schema.tokens).values({ mint: "dual-paper-test", discoverySource: "test" }).returning();
    const repo = new OpportunityRepository(db);
    const positions = new PaperPositionRepository(db);
    const inputs = versions.map((version) => ({
      tokenId: token!.id, strategyVersionId: version.id, stream: "AUTO_PAPER" as const,
      provenance: { sourceType: "LIVE" as const, sourceProvider: "test", sourceTier: "PRIMARY" as const,
        sourceTimestamp: at, dataTimestamp: at, decisionTimestamp: at, dataQuality: 1 },
      decisionKind: "ENTER" as const, finalScore: 85, reasons: [], risks: [], rejectionReasons: [],
      decidedAt: at, respondBy: null,
      snapshot: { tokenId: token!.id, observedAt: at, features: {}, missingFields: [], dataCompleteness: 1,
        scoreEngineVersion: "1", featureSetVersion: "1", inputHash: "same-market-observation" },
    }));
    const opportunities = [];
    for (const input of inputs) opportunities.push(await repo.create(input));
    expect(opportunities.map((o) => o.kind)).toEqual(["CREATED", "CREATED"]);
    expect(opportunities[0]!.opportunityId).not.toBe(opportunities[1]!.opportunityId);
    for (const [i, input] of inputs.entries()) expect(await repo.create(input)).toEqual({ kind: "DUPLICATE", opportunityId: opportunities[i]!.opportunityId });
    const opened = [];
    for (const [index, version] of versions.entries()) {
      opened.push(await positions.open({ opportunityId: opportunities[index]!.opportunityId, tokenId: token!.id,
        strategyVersionId: version.id, stream: "AUTO_PAPER", sizingMode: "RISK_BASED", entryNotional: eur(index === 0 ? 50 : 100),
        entryAmountRaw: 100n, entryCostsMinor: 100n, openedAt: at, fromState: "OFFERED", sourceType: "LIVE" }));
    }
    const read = (index: number) => loadPaperTrading({ db, strategyName: PAPER_PROFILES[index]!.candidate.strategyId, now: at });
    const standard = await read(0);
    const offensive = await read(1);
    expect(standard.kind).toBe("READY"); expect(offensive.kind).toBe("READY");
    if (standard.kind !== "READY" || offensive.kind !== "READY") throw new Error("Account unavailable");
    expect(standard.account.cash).toEqual(eur(2949));
    expect(offensive.account.cash).toEqual(eur(2899));
    expect(standard.open).toHaveLength(1); expect(offensive.open).toHaveLength(1);
    const position = opened[1]!;
    if (position.kind !== "OPENED") throw new Error("Position unavailable");
    await positions.settleSale({ positionId: position.positionId, expectedVersion: 0, soldAmountRaw: 100n,
      proceeds: eur(120), costs: eur(1), at, reason: "TAKE_PROFIT", levelIndex: null,
      maxAdverseExcursion: 0, maxFavorableExcursion: .2, valuation: { source: "TEST_FIXTURE" } });
    expect(await read(0)).toEqual(standard);
    const settled = await read(1);
    if (settled.kind !== "READY") throw new Error("Account unavailable");
    expect(settled.account.cash).toEqual(eur(3018));
    expect(settled.closedCount).toBe(1); expect(settled.open).toHaveLength(0);
  } finally { await close(); }
}, 30_000);


it("persists distinct strategy decisions for an identical feature observation", async () => {
  const { createHarness } = await import("./harness");
  const { testFixtureRequest } = await import("../test-fixture");
  const { runOpportunityPipeline } = await import("../opportunity-pipeline");
  const at = new Date("2026-09-20T12:00:00Z");
  const h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "dual-account" });
    for (const profile of PAPER_PROFILES) {
      const version = await ensurePaperCandidateVersion(h.db, at, profile.candidate);
      const deps = h.deps({ strategyVersionId: strategyVersionId(version.id), parameters: profile.candidate.parameters });
      await runOpportunityPipeline(request, { ...deps, decisionContext: { ...deps.decisionContext, tokenBlacklisted: true } });
      await runOpportunityPipeline(request, { ...deps, decisionContext: { ...deps.decisionContext, tokenBlacklisted: true } });
    }
    const decisions = await h.db.select().from(schema.decisions);
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((d) => d.strategyVersionId)).size).toBe(2);
    expect(decisions.every((d) => d.branchCount === 2)).toBe(true);
  } finally { await h.close(); }
}, 30_000);


it("runs both profiles automatically under the existing paper selector", async () => {
  const { buildHandlers } = await import("../../handlers");
  const { createLogger } = await import("@sae/observability");
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date(Date.now() - 1000);
    const [token] = await db.insert(schema.tokens).values({ mint: "1".repeat(43) + "2", discoverySource: "test", firstSeenAt: at }).returning();
    await db.insert(schema.tokenSnapshots).values({ tokenId: token!.id, observedAt: at,
      priceUsd: 1, marketCapUsd: 1000000, liquidityUsd: 100000, volume24hUsd: 50000,
      dataCompleteness: 1, sourceProviderId: "jupiter-quote" });
    const handler = buildHandlers({ db, logger: createLogger({ service: "test", level: "error" }),
      env: { DATABASE_URL: "postgres://test.invalid/test", PAPER_STRATEGY: "memecoin-risk-managed-v1" } }).EVALUATE_OPPORTUNITY!;
    const result = await handler.handle({} as never) as { processed: number; accounts: { label: string; entryThreshold: number; outcomes: Record<string, number> }[] };
    expect(result.processed).toBe(1);
    expect(result.accounts.map((a) => [a.label, a.entryThreshold])).toEqual([["Standard", 75], ["Offensiv", 65]]);
    expect(result.accounts.map((a) => Object.values(a.outcomes).reduce((sum, n) => sum + n, 0))).toEqual([1, 1]);
    expect(await db.select().from(schema.paperPositions)).toHaveLength(0); // Missing live data never becomes a forced trade.
  } finally { await close(); }
}, 30_000);
