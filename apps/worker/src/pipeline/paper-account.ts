import { and, eq, like } from "drizzle-orm";
import { money, mulDiv, type Money } from "@sae/core";
import { schema, type Database } from "@sae/db";
import type { PortfolioState } from "@sae/risk";

type Position = Pick<typeof schema.paperPositions.$inferSelect,
  "id" | "tokenId" | "strategyVersionId" | "entryNotionalMinor" | "currency" |
  "entryAmountRaw" | "remainingAmountRaw" | "realizedPnlMinor" | "costsPaidMinor" |
  "openedAt" | "closedAt">;
type Event = Pick<typeof schema.paperPositionEvents.$inferSelect, "positionId" | "kind" | "at" | "detail">;

export type PaperAccount =
  | { readonly kind: "BLOCKED"; readonly reason: "UNRECONCILED_PAPER_ACCOUNT" }
  | {
      readonly kind: "READY";
      readonly cash: Money;
      /** Book value, not a mark-to-market measurement. */
      readonly bookValue: Money;
      /** Conservative sizing basis: open tokens contribute zero here. */
      readonly portfolio: PortfolioState;
      readonly closedReturns: readonly { readonly strategyVersionId: string; readonly netReturn: number }[];
    };

function integer(value: unknown): bigint | null {
  return typeof value === "string" && /^-?\d+$/.test(value) ? BigInt(value) : null;
}

/**
 * Reconcile the current paper ledger. Not a historical replay: later fills make
 * an earlier asOf invalid. Never infer cash from token signal prices.
 */
export function reconcilePaperAccount(input: {
  readonly initialCash: Money;
  readonly positions: readonly Position[];
  readonly events: readonly Event[];
  readonly asOf: Date;
}): PaperAccount {
  const blocked = { kind: "BLOCKED", reason: "UNRECONCILED_PAPER_ACCOUNT" } as const;
  const { initialCash, asOf } = input;
  if (initialCash.minor <= 0n || !Number.isFinite(asOf.getTime())) return blocked;
  const midnight = new Date(asOf);
  midnight.setUTCHours(0, 0, 0, 0);
  const eventsByPosition = new Map<string, Event[]>();
  for (const event of input.events) {
    const list = eventsByPosition.get(event.positionId) ?? [];
    list.push(event);
    eventsByPosition.set(event.positionId, list);
  }
  let cash = initialCash.minor;
  let committed = 0n;
  let today = 0n;
  const openPositions: PortfolioState["openPositions"][number][] = [];
  const closed: { id: string; at: Date; strategyVersionId: string; net: bigint; basis: bigint }[] = [];
  const ids = new Set<string>();
  for (const row of input.positions) {
    if (ids.has(row.id)) return blocked;
    ids.add(row.id);
    if (row.currency !== initialCash.currency || row.entryNotionalMinor <= 0n || row.entryAmountRaw <= 0n ||
      row.remainingAmountRaw < 0n || row.remainingAmountRaw > row.entryAmountRaw || row.costsPaidMinor < 0n ||
      !Number.isFinite(row.openedAt.getTime()) || row.openedAt > asOf ||
      (row.closedAt !== null && (!Number.isFinite(row.closedAt.getTime()) || row.closedAt > asOf || row.closedAt < row.openedAt)) ||
      (row.closedAt === null) !== (row.remainingAmountRaw > 0n)) return blocked;
    let sold = 0n;
    let basis = 0n;
    let gross = 0n;
    let saleCosts = 0n;
    let entryCosts: bigint | null = null;
    let opened = 0;
    for (const event of eventsByPosition.get(row.id) ?? []) {
      if (!Number.isFinite(event.at.getTime()) || event.at > asOf || event.at < row.openedAt ||
        (row.closedAt !== null && event.at > row.closedAt)) return blocked;
      const detail = event.detail as Record<string, unknown>;
      if (detail === null || typeof detail !== "object") return blocked;
      if (event.kind === "OPENED") {
        opened++;
        if (event.at.getTime() !== row.openedAt.getTime() ||
          integer(detail["entryNotionalMinor"]) !== row.entryNotionalMinor || detail["currency"] !== row.currency) return blocked;
        // Older OPENED events omit entry costs. Reconcile them from total minus
        // fully documented sale costs, rather than assuming zero.
        if (detail["entryCostsMinor"] !== undefined) {
          entryCosts = integer(detail["entryCostsMinor"]);
          if (entryCosts === null || entryCosts < 0n) return blocked;
        }
      } else if (event.kind === "PARTIAL_TP" || event.kind === "EXIT_FILL") {
        const amount = integer(detail["soldAmountRaw"]);
        const proceeds = integer(detail["proceedsMinor"]);
        const allocated = integer(detail["costBasisMinor"]);
        const costs = integer(detail["costsMinor"]);
        if (amount === null || amount <= 0n || proceeds === null || proceeds < 0n || allocated === null || allocated < 0n ||
          costs === null || costs < 0n || detail["currency"] !== row.currency) return blocked;
        sold += amount;
        basis += allocated;
        gross += proceeds - allocated;
        saleCosts += costs;
        if (event.at >= midnight) today += proceeds - allocated - costs;
      } else if (event.kind !== "CLOSED") {
        // Unknown balance-changing legacy event semantics are not spendable cash.
        return blocked;
      }
    }
    const expectedBasis = mulDiv(row.entryNotionalMinor, row.entryAmountRaw - row.remainingAmountRaw, row.entryAmountRaw, "floor");
    if (opened !== 1 || sold !== row.entryAmountRaw - row.remainingAmountRaw || basis !== expectedBasis ||
      gross !== row.realizedPnlMinor || saleCosts > row.costsPaidMinor) return blocked;
    const actualEntryCosts = row.costsPaidMinor - saleCosts;
    if (entryCosts !== null && entryCosts !== actualEntryCosts) return blocked;
    if (row.openedAt >= midnight) today -= actualEntryCosts;
    const remainingBasis = row.entryNotionalMinor - basis;
    cash += gross - row.costsPaidMinor - remainingBasis;
    committed += remainingBasis;
    if (row.closedAt === null) {
      openPositions.push({ tokenId: row.tokenId, notional: money(remainingBasis, row.currency) });
    } else {
      closed.push({ id: row.id, at: row.closedAt, strategyVersionId: row.strategyVersionId,
        net: gross - row.costsPaidMinor, basis: row.entryNotionalMinor });
    }
  }
  if ([...eventsByPosition.keys()].some((id) => !ids.has(id))) return blocked;
  closed.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
  let consecutiveLosses = 0;
  for (const trade of closed) {
    if (trade.net >= 0n) break;
    consecutiveLosses++;
  }
  return {
    kind: "READY", cash: money(cash, initialCash.currency), bookValue: money(cash + committed, initialCash.currency),
    portfolio: {
      value: money(cash > 0n ? cash : 0n, initialCash.currency), openPositions,
      realizedTodayPnl: money(today, initialCash.currency), consecutiveLosses,
    },
    closedReturns: closed.map((trade) => ({ strategyVersionId: trade.strategyVersionId,
      netReturn: Number(mulDiv(trade.net, 1_000_000_000n, trade.basis, "floor")) / 1_000_000_000 })),
  };
}

/** Family lock keeps entry/exit bookings stable across positions and failed-attempt reads. */
export async function loadPaperAccount(input: {
  readonly db: Database;
  readonly strategyId: string;
  readonly initialCash: Money;
  readonly asOf: Date;
}): Promise<PaperAccount> {
  return input.db.transaction(async (tx) => {
    const [family] = await tx.select({ id: schema.strategies.id }).from(schema.strategies)
      .where(eq(schema.strategies.id, input.strategyId)).for("update");
    if (family === undefined) return { kind: "BLOCKED", reason: "UNRECONCILED_PAPER_ACCOUNT" };
    return readPaperAccount({ ...input, db: tx });
  });
}

async function readPaperAccount(input: Parameters<typeof loadPaperAccount>[0]): Promise<PaperAccount> {
  const rows = await input.db.select({ position: schema.paperPositions, event: schema.paperPositionEvents })
    .from(schema.paperPositions)
    .innerJoin(schema.strategyVersions, eq(schema.strategyVersions.id, schema.paperPositions.strategyVersionId))
    .leftJoin(schema.paperPositionEvents, eq(schema.paperPositionEvents.positionId, schema.paperPositions.id))
    .where(and(eq(schema.strategyVersions.strategyId, input.strategyId),
      eq(schema.paperPositions.stream, "AUTO_PAPER"), eq(schema.paperPositions.sizingMode, "RISK_BASED"),
      eq(schema.paperPositions.sourceType, "LIVE"), eq(schema.paperPositions.isTestFixture, false)));
  const account = reconcilePaperAccount({
    initialCash: input.initialCash, asOf: input.asOf,
    positions: [...new Map(rows.map((row) => [row.position.id, row.position])).values()],
    events: rows.flatMap((row) => row.event === null ? [] : [row.event]),
  });
  if (account.kind !== "READY") return account;
  const failures = await input.db.select({ intentId: schema.tradeIntents.id, executionState: schema.executions.state, cost: schema.executions.actualCostMinor, at: schema.executions.confirmedAt,
      currency: schema.tradeIntents.currency })
    .from(schema.tradeIntents)
    .innerJoin(schema.strategyVersions, eq(schema.strategyVersions.id, schema.tradeIntents.strategyVersionId))
    .leftJoin(schema.executions, eq(schema.executions.intentId, schema.tradeIntents.id))
    .where(and(eq(schema.strategyVersions.strategyId, input.strategyId),
      eq(schema.tradeIntents.mode, "paper"), eq(schema.tradeIntents.origin, "auto"), eq(schema.tradeIntents.side, "buy"),
      eq(schema.tradeIntents.state, "FAILED"), like(schema.tradeIntents.idempotencyKey, "funded-paper-buy:%")));
  let costs = 0n;
  let today = 0n;
  const midnight = new Date(input.asOf); midnight.setUTCHours(0, 0, 0, 0);
  const attempts = new Set<string>();
  for (const failure of failures) {
    if (attempts.has(failure.intentId) || failure.executionState !== "FAILED") return { kind: "BLOCKED", reason: "UNRECONCILED_PAPER_ACCOUNT" };
    attempts.add(failure.intentId);
    if (failure.cost === null || failure.cost < 0n || failure.at === null || !Number.isFinite(failure.at.getTime()) || failure.at > input.asOf ||
      failure.currency !== input.initialCash.currency) return { kind: "BLOCKED", reason: "UNRECONCILED_PAPER_ACCOUNT" };
    costs += failure.cost;
    if (failure.at >= midnight) today += failure.cost;
  }
  const cash = money(account.cash.minor - costs, account.cash.currency);
  return { ...account, cash, bookValue: money(account.bookValue.minor - costs, cash.currency),
    portfolio: { ...account.portfolio, value: money(cash.minor > 0n ? cash.minor : 0n, cash.currency),
      realizedTodayPnl: money(account.portfolio.realizedTodayPnl.minor - today, cash.currency) },
  };
}
