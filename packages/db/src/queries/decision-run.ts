import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../client";
import { jobQueue } from "../schema/queue";

export interface SizingReport {
  readonly currency: "EUR" | "USD";
  readonly minimumMinor: string;
  readonly portfolioCapMinor: string;
  readonly confidenceCapMinor: string;
  readonly maximumMinor: string;
  readonly tradeable: boolean;
}

export interface DecisionRunReport {
  readonly finishedAt: Date;
  readonly processed: number | null;
  readonly outcomes: Readonly<Record<string, number>> | null;
  readonly missingFields: Readonly<Record<string, number>> | null;
  readonly tracked: number | null;
  readonly skipped: number | null;
  readonly roundComplete: boolean | null;
  readonly bestScore: number | null;
  readonly entryThreshold: number | null;
  readonly sizing: SizingReport | null;
  readonly accounts?: readonly { label: string; entryThreshold: number; outcomes: Readonly<Record<string, number>> }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function counts(value: unknown): Readonly<Record<string, number>> | null {
  const object = record(value);
  if (object === null) return null;
  const entries = Object.entries(object);
  if (entries.some(([key, n]) => !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(key) || count(n) === null)) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function sizingReport(value: unknown): SizingReport | null {
  const r = record(value);
  if (r === null || (r.currency !== "EUR" && r.currency !== "USD") || typeof r.tradeable !== "boolean") return null;
  const minor = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);
  if (!minor(r.minimumMinor) || !minor(r.portfolioCapMinor) || !minor(r.confidenceCapMinor) || !minor(r.maximumMinor)) return null;
  return {
    currency: r.currency, tradeable: r.tradeable, minimumMinor: r.minimumMinor,
    portfolioCapMinor: r.portfolioCapMinor, confidenceCapMinor: r.confidenceCapMinor,
    maximumMinor: r.maximumMinor,
  };
}

/** Alte Ergebnisse bleiben lesbar; nicht erhobene Felder bleiben unbekannt. */
export function parseDecisionRun(result: unknown, finishedAt: Date): DecisionRunReport {
  const r = record(result);
  return {
    finishedAt,
    processed: count(r?.processed),
    outcomes: counts(r?.outcomes),
    missingFields: counts(r?.missingFields),
    tracked: count(r?.tracked),
    skipped: count(r?.skipped),
    roundComplete: typeof r?.roundComplete === "boolean" ? r.roundComplete : null,
    bestScore: count(r?.bestScore),
    entryThreshold: count(r?.entryThreshold),
    sizing: sizingReport(r?.sizing),
    ...(Array.isArray(r?.accounts) ? { accounts: r.accounts.flatMap((value: unknown) => {
      const a = record(value);
      const threshold = count(a?.entryThreshold);
      const outcomes = counts(a?.outcomes);
      return a !== null && (a.label === "Standard" || a.label === "Offensiv" || a.label === "Legacy")
        && threshold !== null && outcomes !== null
        ? [{ label: a.label, entryThreshold: threshold, outcomes }] : [];
    }) } : {}),
  };
}

/** Keine neue Tabelle, kein Nachschreiben historischer Entscheidungen. */
export async function loadLatestDecisionRun(db: Database): Promise<DecisionRunReport | null> {
  const [row] = await db.select({ result: jobQueue.result, finishedAt: jobQueue.finishedAt })
    .from(jobQueue)
    .where(and(
      eq(jobQueue.kind, "EVALUATE_OPPORTUNITY"), eq(jobQueue.state, "DONE"),
      gt(jobQueue.attempts, 0),
      sql`coalesce(${jobQueue.result}->>'status', '') <> 'SUPERSEDED'`,
    ))
    .orderBy(desc(jobQueue.finishedAt), desc(jobQueue.id)).limit(1);
  return row === undefined || row.finishedAt === null ? null : parseDecisionRun(row.result, row.finishedAt);
}

/** Zukunftszeitpunkte sind keine frische Messung. */
export function isRecentObservation(at: Date | null, now: Date, windowMs = 180_000): boolean {
  if (at === null) return false;
  const age = now.getTime() - at.getTime();
  return age >= 0 && age < windowMs;
}
