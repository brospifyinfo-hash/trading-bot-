import { isDeepStrictEqual } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { money } from "@sae/core";
import { strategyParametersSchema, MEMECOIN_PAPER_CANDIDATE } from "@sae/config";
import { schema, PAPER_INITIAL_CASH, type Database } from "@sae/db";
import { computePositionSize, checkExposure, dailyLossPct } from "@sae/risk";
import { loadPaperAccount } from "./paper-account";
import type { AutoPaperResult, PipelineDeps } from "./opportunity-pipeline";

/** A simulation setting, not an observed balance. Shared across candidate versions. */
export { PAPER_INITIAL_CASH } from "@sae/db";

/**
 * Serialize funded entries across all versions in a strategy family. The lock,
 * last budget check, simulated attempt and position booking share a transaction.
 * Only for LIVE-data paper entries; fixture/manual/fixed runs have other ledgers.
 */
export async function withPaperBuyAccount(input: {
  readonly deps: PipelineDeps;
  readonly opportunityId: string;
  readonly tokenId: string;
  readonly executeAndOpen: (db: Database) => Promise<AutoPaperResult>;
}): Promise<AutoPaperResult> {
  const { deps } = input;
  const order = deps.riskBasedEntry;
  const blocked = (reason: string): AutoPaperResult => ({ kind: "ACCOUNT_BLOCKED", reason });
  if (order?.roundTripCosts === undefined || order.quotedAt === undefined) return blocked("MISSING_COST_RESERVATION");
  if (deps.executor.mode !== "paper" || deps.decisionContext.executionMode !== "paper") return blocked("PAPER_ONLY");
  const reserve = order.roundTripCosts;
  if (order.notional.minor <= 0n || order.amountRaw <= 0n) return blocked("INVALID_ORDER_SIZE");
  if (reserve.currency !== order.notional.currency || reserve.minor < 0n ||
    order.notional.currency !== PAPER_INITIAL_CASH.currency) return blocked("INVALID_COST_RESERVATION");
  return deps.db.transaction(async (tx) => {
    const [version] = await tx.select().from(schema.strategyVersions)
      .where(eq(schema.strategyVersions.id, String(deps.strategyVersionId))).limit(1);
    if (version === undefined) return blocked("INVALID_STRATEGY_VERSION");
    await tx.select({ id: schema.strategies.id }).from(schema.strategies)
      .where(eq(schema.strategies.id, version.strategyId)).for("update");
    // Read after acquiring the family lock: another worker may have retired it.
    const [current] = await tx.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.id, version.id));
    const parsed = strategyParametersSchema.safeParse(current?.parameters);
    if (!parsed.success || current?.retiredAt !== null || !isDeepStrictEqual(parsed.data, deps.parameters)) {
      return blocked("STRATEGY_VERSION_MISMATCH");
    }
    const [opportunity] = await tx.select().from(schema.opportunities)
      .where(eq(schema.opportunities.id, input.opportunityId)).limit(1);
    if (opportunity === undefined || opportunity.tokenId !== input.tokenId || opportunity.strategyVersionId !== version.id ||
      opportunity.stream !== "AUTO_PAPER" || opportunity.sourceType !== "LIVE" || opportunity.isTestFixture) {
      return blocked("INVALID_ACCOUNT_OPPORTUNITY");
    }
    const [existing] = await tx.select({ id: schema.paperPositions.id }).from(schema.paperPositions)
      .where(eq(schema.paperPositions.opportunityId, input.opportunityId)).limit(1);
    if (existing !== undefined) return { kind: "ALREADY_OPEN", positionId: existing.id };
    if (opportunity.state !== "OFFERED") return { kind: "NOT_OFFERED", actualState: opportunity.state };
    const key = `funded-paper-buy:${input.opportunityId}`;
    const [attempt] = await tx.select({ id: schema.tradeIntents.id }).from(schema.tradeIntents)
      .where(eq(schema.tradeIntents.idempotencyKey, key)).limit(1);
    if (attempt !== undefined) return blocked("ATTEMPT_ALREADY_RECORDED");
    const now = deps.clock.now();
    const lockPrefix = `PAPER:${version.strategyId}:`;
    const locks = await tx.select().from(schema.circuitBreakerState).where(inArray(schema.circuitBreakerState.name,
      [`${lockPrefix}DAILY_LOSS`, `${lockPrefix}CONSECUTIVE_LOSSES`]));
    const activeLock = locks.find((lock) => lock.state === "OPEN" && (lock.cooldownUntil === null || lock.cooldownUntil > now));
    if (activeLock !== undefined) return blocked(activeLock.name.slice(lockPrefix.length));
    const latch = async (reason: "DAILY_LOSS" | "CONSECUTIVE_LOSSES") => {
      const midnight = new Date(now); midnight.setUTCDate(midnight.getUTCDate() + 1); midnight.setUTCHours(0, 0, 0, 0);
      const values = { state: "OPEN" as const, openedAt: now, updatedAt: now,
        cooldownUntil: reason === "DAILY_LOSS" ? midnight : null, reason,
        detail: { scope: "PAPER_ENTRIES_ONLY", strategyId: version.strategyId } };
      await tx.insert(schema.circuitBreakerState).values({ name: `${lockPrefix}${reason}`, ...values })
        .onConflictDoUpdate({ target: schema.circuitBreakerState.name, set: values });
      return blocked(reason);
    };
    const age = now.getTime() - order.quotedAt!.getTime();
    if (!Number.isFinite(age) || age < 0 || age >= 120_000) return blocked("STALE_COST_RESERVATION");
    const account = await loadPaperAccount({ db: tx, strategyId: version.strategyId, initialCash: PAPER_INITIAL_CASH, asOf: now });
    if (account.kind !== "READY") return blocked(account.reason);
    if (account.portfolio.openPositions.some((position) => position.tokenId === input.tokenId)) return blocked("DUPLICATE_TOKEN");
    if (account.cash.minor < order.notional.minor + reserve.minor) return blocked("INSUFFICIENT_PAPER_CASH");
    if (dailyLossPct(account.portfolio) >= deps.parameters.risk.maxDailyLossPct) return latch("DAILY_LOSS");
    if (account.portfolio.consecutiveLosses >= deps.parameters.risk.maxConsecutiveLosses) return latch("CONSECUTIVE_LOSSES");
    const exposure = checkExposure(account.portfolio, money(order.notional.minor + reserve.minor, order.notional.currency), deps.parameters);
    if (!exposure.withinLimits) return blocked(exposure.violations.join(","));
    // Re-evaluate with current cash, not the stale balance used before waiting.
    // Confidence zero deliberately retains the most conservative candidate cap.
    const cap = computePositionSize({ portfolioValue: account.portfolio.value,
      stopDistance: deps.parameters.exit.stopLossBps / 10_000, evConfidence: 0,
      maxNotionalByLiquidity: account.cash, minimumNotional: money(1n, order.notional.currency), parameters: deps.parameters,
    });
    if (!cap.tradeable || order.notional.minor > cap.size.minor) return blocked("STALE_SIZE_APPROVAL");
    if (reserve.minor * 10_000n > order.notional.minor * BigInt(MEMECOIN_PAPER_CANDIDATE.maxRoundTripCostBps)) return blocked("COSTS_EXCEED_LIMIT");
    const result = await input.executeAndOpen(tx);
    if (result.kind !== "OPENED" && result.kind !== "NOT_FILLED") return result;
    const outcome = result.outcome;
    if (outcome.kind === "FILLED" && (outcome.costs.total.currency !== reserve.currency || outcome.costs.total.minor > reserve.minor)) {
      // Nothing is sent to a chain; roll back this inconsistent simulated fill.
      throw new Error("Paper fill exceeds reserved costs");
    }
    if (outcome.kind === "ABORTED") return result;
    if (outcome.costs.total.currency !== reserve.currency || outcome.costs.total.minor < 0n) throw new Error("Invalid paper attempt costs");
    const [intent] = await tx.insert(schema.tradeIntents).values({
      tokenId: input.tokenId, mint: deps.outputMint, mode: "paper", origin: "auto", side: "buy",
      state: outcome.kind === "FAILED" ? "FAILED" : "CLOSED", idempotencyKey: key,
      plannedNotionalMinor: order.notional.minor, currency: order.notional.currency,
      maxSlippageBps: deps.parameters.risk.maxSlippageBps, strategyVersionId: version.id,
      createdAt: now, expiresAt: new Date(now.getTime() + 120_000),
    }).returning({ id: schema.tradeIntents.id });
    if (intent === undefined) throw new Error("Paper attempt not recorded");
    await tx.insert(schema.executions).values({
      intentId: intent.id, state: outcome.kind === "FAILED" ? "FAILED" : "CLOSED",
      actualCostMinor: outcome.costs.total.minor, estimatedCostMinor: reserve.minor,
      confirmedAt: outcome.kind === "FAILED" ? outcome.failedAt : outcome.filledAt,
      error: outcome.kind === "FAILED" ? outcome.reason : null,
    });
    return result;
  });
}
