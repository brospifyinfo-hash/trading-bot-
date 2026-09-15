import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import * as schema from "../schema/index";
import { PAPER_INITIAL_CASH, readPaperAccount } from "./paper-account";

/** One read-only snapshot; shares the worker ledger, without locking its writes. */
export async function loadPaperTrading(input: { db: Database; strategyName: string; now: Date }) {
  return input.db.transaction(async (tx) => {
    const [family] = await tx.select().from(schema.strategies)
      .where(eq(schema.strategies.name, input.strategyName)).limit(1);
    if (!family) return { kind: "WAITING" as const, updatedAt: input.now };
    const account = await readPaperAccount({
      db: tx, strategyId: family.id, initialCash: PAPER_INITIAL_CASH, asOf: input.now,
    });
    if (account.kind !== "READY") return { kind: "BLOCKED" as const, updatedAt: input.now };
    const rows = await tx.select({ position: schema.paperPositions, token: schema.tokens })
      .from(schema.paperPositions)
      .innerJoin(schema.strategyVersions, eq(schema.strategyVersions.id, schema.paperPositions.strategyVersionId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.paperPositions.tokenId))
      .where(and(eq(schema.strategyVersions.strategyId, family.id),
        eq(schema.paperPositions.stream, "AUTO_PAPER"), eq(schema.paperPositions.sizingMode, "RISK_BASED"),
        eq(schema.paperPositions.sourceType, "LIVE"), eq(schema.paperPositions.isTestFixture, false)));
    const closed = rows.filter((r) => r.position.closedAt !== null)
      .sort((a, b) => b.position.closedAt!.getTime() - a.position.closedAt!.getTime() ||
        a.position.id.localeCompare(b.position.id));
    return { kind: "READY" as const, updatedAt: input.now, account, initialCash: PAPER_INITIAL_CASH,
      open: rows.filter((r) => r.position.closedAt === null)
        .sort((a, b) => b.position.openedAt.getTime() - a.position.openedAt.getTime()),
      closed: closed.slice(0, 100), closedCount: closed.length };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export type PaperTrading = Awaited<ReturnType<typeof loadPaperTrading>>;
