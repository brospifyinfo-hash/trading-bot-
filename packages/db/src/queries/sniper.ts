import { desc, eq } from "drizzle-orm";
import type { Database } from "../client";
import { jobQueue } from "../schema/queue";
import { jobCheckpoints } from "../schema/pipeline";

export async function loadPaperSniper(db: Database) {
  const [feed, jobs] = await Promise.all([
    db.select().from(jobCheckpoints).where(eq(jobCheckpoints.jobKey, "paper-sniper:feed")).limit(1),
    db.select({ state: jobQueue.state, payload: jobQueue.payload, result: jobQueue.result,
      at: jobQueue.enqueuedAt }).from(jobQueue).where(eq(jobQueue.kind, "PAPER_SNIPER"))
      .orderBy(desc(jobQueue.enqueuedAt)).limit(10),
  ]);
  let data: Record<string, unknown> = {};
  try { const raw = feed[0]?.doneUnits; if (Array.isArray(raw) && typeof raw[0] === "string") data = JSON.parse(raw[0]) ?? {}; } catch { /* no fabricated status */ }
  const count = (key: string) => typeof data[key] === "number" && Number.isSafeInteger(data[key]) ? Number(data[key]) : null;
  const text = (value: unknown) => typeof value === "string" ? value.slice(0,150) : null;
  return { updatedAt: feed[0]?.updatedAt ?? null, state: text(data.state), received: count("received"),
    dispatched: count("dispatched"), dropped: count("dropped"), pending: count("pending"), lastEvent: text(data.lastEvent),
    jobs: jobs.map((j) => {
      const p = j.payload as Record<string, unknown> | null, r = j.result as Record<string, unknown> | null;
      return { at: j.at, mint: text(p?.mint), event: text(p?.kind), outcome: text(r?.status) ?? j.state,
        score: typeof r?.score === "number" && Number.isFinite(r.score) ? r.score : null,
        latencyMs: typeof r?.latencyMs === "number" ? r.latencyMs : null };
    }) };
}
