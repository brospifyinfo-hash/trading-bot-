import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bps, eur } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { PaperPositionRepository, schema, loadPaperTrading, type Database } from "@sae/db";
import type { ExecutionOutcome } from "@sae/trading";
import { createHarness } from "./harness";
import { withPaperBuyAccount, PAPER_INITIAL_CASH } from "../paper-buy-account";
import { loadPaperAccount } from "../paper-account";
import type { AutoPaperResult, PipelineDeps } from "../opportunity-pipeline";

const at = new Date("2026-09-14T12:00:00Z");
async function setup() {
  const h = await createHarness(at);
  await h.db.update(schema.strategyVersions).set({ parameters: MEMECOIN_PAPER_CANDIDATE.parameters })
    .where(eq(schema.strategyVersions.id, h.strategyVersionId));
  const [version] = await h.db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, h.strategyVersionId));
  let sequence = 0;
  async function opportunity() {
    const index = sequence++;
    const [feature] = await h.db.insert(schema.featureSnapshots).values({ tokenId: h.tokenId, observedAt: at,
      features: {}, dataCompleteness: 1, scoreEngineVersion: `buy-${index}`, featureSetVersion: "1", inputHash: `buy-${index}`,
    }).returning();
    const [row] = await h.db.insert(schema.opportunities).values({ tokenId: h.tokenId, strategyVersionId: h.strategyVersionId,
      featureSnapshotId: feature!.id, stream: "AUTO_PAPER", state: "OFFERED", decisionKind: "ENTER",
      decidedAt: new Date(at.getTime() - index), sourceType: "LIVE",
    }).returning();
    return row!.id;
  }
  const deps = h.deps({ parameters: MEMECOIN_PAPER_CANDIDATE.parameters,
    riskBasedEntry: { amountRaw: 20_604_395n, notional: eur(18.75), roundTripCosts: eur(.35), quotedAt: at },
  });
  const simulated = await deps.executor.execute({ intentId: "fixture", inputMint: deps.inputMint as never,
    outputMint: deps.outputMint as never, side: "buy", inAmount: 20_604_395n, notional: eur(18.75),
    plannedAt: at, maxSlippageBps: bps(1000),
  });
  if (simulated.kind !== "FILLED") throw new Error("Fixture");
  const filled = simulated;
  let executions = 0;
  async function run(id: string, overrides: Partial<PipelineDeps> = {}, fail = false): Promise<AutoPaperResult> {
    return withPaperBuyAccount({ deps: { ...deps, ...overrides }, tokenId: h.tokenId, opportunityId: id,
      executeAndOpen: async (db: Database) => {
        executions++;
        if (fail) return { kind: "NOT_FILLED", outcome: { ...filled, kind: "FAILED", reason: "BLOCKHASH_EXPIRED", failedAt: at } as ExecutionOutcome };
        const opened = await new PaperPositionRepository(db).open({ opportunityId: id, tokenId: h.tokenId,
          strategyVersionId: h.strategyVersionId, stream: "AUTO_PAPER", sizingMode: "RISK_BASED", sourceType: "LIVE",
          fromState: "OFFERED", entryNotional: eur(18.75), entryAmountRaw: filled.outAmount,
          entryCostsMinor: filled.costs.total.minor, openedAt: at,
        });
        if (opened.kind !== "OPENED") throw new Error("Fixture open");
        return { kind: "OPENED", positionId: opened.positionId, outcome: filled };
      },
    });
  }
  const account = () => loadPaperAccount({ db: h.db, strategyId: version!.strategyId, initialCash: PAPER_INITIAL_CASH, asOf: at });
  return { ...h, deps, filled, opportunity, run, account, executions: () => executions };
}

describe("funded paper entry transaction", () => {
  it("books a fill once and rejects another open position in the same token", async () => {
    const h = await setup();
    try {
      const id = await h.opportunity();
      expect((await h.run(id)).kind).toBe("OPENED");
      expect((await h.run(id)).kind).toBe("ALREADY_OPEN");
      expect(await h.run(await h.opportunity())).toMatchObject({ kind: "ACCOUNT_BLOCKED", reason: "DUPLICATE_TOKEN" });
      expect(h.executions()).toBe(1);
      const account = await h.account();
      expect(account.kind).toBe("READY");
      if (account.kind === "READY") expect(account.cash.minor).toBe(300000n - 1875n - h.filled.costs.total.minor);
    } finally { await h.close(); }
  });
  it("allows only one of two simultaneous entries for the same token", async () => {
    const h = await setup();
    try {
      const first = await h.opportunity();
      const second = await h.opportunity();
      const results = await Promise.all([h.run(first), h.run(second)]);
      expect(results.map((result) => result.kind).sort()).toEqual(["ACCOUNT_BLOCKED", "OPENED"]);
      expect(h.executions()).toBe(1);
      expect(await h.db.select().from(schema.paperPositions)).toHaveLength(1);
    } finally { await h.close(); }
  });
  it("charges a failed attempt without creating a position and prevents free retries", async () => {
    const h = await setup();
    try {
      const id = await h.opportunity();
      expect((await h.run(id, {}, true)).kind).toBe("NOT_FILLED");
      expect(await h.run(id, {}, true)).toMatchObject({ kind: "ACCOUNT_BLOCKED", reason: "ATTEMPT_ALREADY_RECORDED" });
      expect(h.executions()).toBe(1);
      const account = await h.account();
      expect(account.kind).toBe("READY");
      if (account.kind === "READY") {
        expect(account.cash.minor).toBe(300000n - h.filled.costs.total.minor);
        expect(account.portfolio.realizedTodayPnl.minor).toBe(-h.filled.costs.total.minor);
        expect(account.portfolio.openPositions).toHaveLength(0);
        const [family] = await h.db.select().from(schema.strategies);
        const dashboard = await loadPaperTrading({ db: h.db, strategyName: family!.name, now: at });
        expect(dashboard.kind).toBe("READY");
        if (dashboard.kind !== "READY") throw new Error("Dashboard unavailable");
        expect(dashboard.account).toEqual(account);
        expect(dashboard.closed).toEqual([]);
        expect(dashboard.open).toEqual([]);

      }
      // A fresh opportunity must use the reduced budget, not the initial 18.75.
      expect(await h.run(await h.opportunity())).toMatchObject({ kind: "ACCOUNT_BLOCKED", reason: "STALE_SIZE_APPROVAL" });
    } finally { await h.close(); }
  });
  it("blocks missing or expired reservations, oversized orders and parameter drift before execution", async () => {
    const h = await setup();
    try {
      const id = await h.opportunity();
      for (const riskBasedEntry of [
        { amountRaw: 1n, notional: eur(18.75) },
        { ...h.deps.riskBasedEntry!, quotedAt: new Date(at.getTime() - 120000) },
        { ...h.deps.riskBasedEntry!, notional: eur(100) },
        { ...h.deps.riskBasedEntry!, roundTripCosts: eur(1) },
      ]) expect((await h.run(id, { riskBasedEntry })).kind).toBe("ACCOUNT_BLOCKED");
      expect((await h.run(id, { parameters: { ...h.deps.parameters, risk: { ...h.deps.parameters.risk, maxOpenPositions: 3 } } })).kind).toBe("ACCOUNT_BLOCKED");
      expect(h.executions()).toBe(0);
    } finally { await h.close(); }
  });
  it("persists a triggered daily entry lock even if the next balance recovers", async () => {
    const h = await setup();
    try {
      await h.run(await h.opportunity(), {}, true);
      // Isolated fixture accounting changes stand in for a large booked loss and recovery.
      await h.db.update(schema.executions).set({ actualCostMinor: 9000n });
      expect(await h.run(await h.opportunity())).toMatchObject({ kind: "ACCOUNT_BLOCKED", reason: "DAILY_LOSS" });
      const [lock] = await h.db.select().from(schema.circuitBreakerState);
      expect(lock?.state).toBe("OPEN");
      expect(lock?.cooldownUntil?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
      await h.db.update(schema.executions).set({ actualCostMinor: 0n });
      expect(await h.run(await h.opportunity())).toMatchObject({ kind: "ACCOUNT_BLOCKED", reason: "DAILY_LOSS" });
      expect(h.executions()).toBe(1);
    } finally { await h.close(); }
  });
  it("rolls back the position when the actual modeled fill exceeds the reserved costs", async () => {
    const h = await setup();
    try {
      await expect(h.run(await h.opportunity(), { riskBasedEntry: { ...h.deps.riskBasedEntry!, roundTripCosts: eur(0) } })).rejects.toThrow("exceeds reserved");
      expect(await h.db.select().from(schema.paperPositions)).toHaveLength(0);
      expect(await h.db.select().from(schema.tradeIntents)).toHaveLength(0);
    } finally { await h.close(); }
  });
});
