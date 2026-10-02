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

export interface CoinDiagnostic {
  readonly mint: string; readonly account: string; readonly outcome: string; readonly detail?: string;
  readonly diagnostics?: { finalScore: number | null; completeness: number; requiredCompleteness: number; weightCoverage: number;
    missing: readonly { field: string; reason: string }[]; unavailableScores: readonly string[] };
}

export interface DecisionRunReport {
  readonly coinDiagnostics?: readonly CoinDiagnostic[];
  readonly finishedAt: Date;
  readonly processed: number | null;
  readonly outcomes: Readonly<Record<string, number>> | null;
  readonly missingFields: Readonly<Record<string, number>> | null;
  readonly tracked: number | null;
  readonly skipped: number | null;
  readonly roundComplete: boolean | null;
  readonly bestScore: number | null;
  readonly entryThreshold: number | null;
  /**
   * Woher die Schwelle stammt, aus Sicht des WORKERS.
   *
   * Entscheidend, weil das Dashboard auf einer anderen Maschine laeuft als der
   * Worker: die Variable steht bei Railway, die Oberflaeche bei Vercel. Liest
   * die Oberflaeche ihre eigene Umgebung, zeigt sie eine Zahl an, mit der nie
   * jemand entschieden hat. Also wird gemeldet, was der Worker benutzt hat.
   */
  readonly entryThresholdSource: "SAVED" | "DEFAULT" | "SET" | null;
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
    coinDiagnostics: parseCoins(r?.coinDiagnostics),
    processed: count(r?.processed),
    outcomes: counts(r?.outcomes),
    missingFields: counts(r?.missingFields),
    tracked: count(r?.tracked),
    skipped: count(r?.skipped),
    roundComplete: typeof r?.roundComplete === "boolean" ? r.roundComplete : null,
    bestScore: count(r?.bestScore),
    entryThreshold: count(r?.entryThreshold),
    entryThresholdSource:
      r?.entryThresholdSource === "SAVED" ||
      r?.entryThresholdSource === "DEFAULT" ||
      // `SET` stammt aus Laeufen, die die Schwelle noch aus der Umgebung
      // lasen. Alte Ergebnisse bleiben lesbar.
      r?.entryThresholdSource === "SET"
        ? r.entryThresholdSource
        : null,
    sizing: sizingReport(r?.sizing),
    ...(Array.isArray(r?.accounts) ? { accounts: r.accounts.flatMap((value: unknown) => {
      const a = record(value);
      const threshold = count(a?.entryThreshold);
      const outcomes = counts(a?.outcomes);
      // Die Etiketten stammen aus eigenem Code und werden hier gegen eine
      // geschlossene Liste geprueft — ein Lauf schreibt sein Ergebnis als
      // JSON, und daraus wird gelesen. "Paper" ist das einzige Konto; die
      // drei alten Etiketten bleiben lesbar, damit historische Laeufe im
      // Dashboard nicht verschwinden.
      return a !== null && (a.label === "Paper" || a.label === "Standard" || a.label === "Offensiv" || a.label === "Sehr offensiv" || a.label === "Legacy")
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

function parseCoins(value: unknown): CoinDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((item: unknown) => {
    const r = record(item);
    if (!r || typeof r.mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint) ||
      // „Paper" ist das eine Konto. Es fehlte hier, waehrend die
      // Kontoliste eine Zeile weiter schon angepasst war — damit haette die
      // Diagnose JE COIN nach der Umstellung lautlos aufgehoert zu
      // erscheinen, also genau die Ansicht, die den Grund nennt. Die drei
      // alten Etiketten bleiben lesbar, damit historische Laeufe nicht
      // verschwinden.
      typeof r.account !== "string" || !["Paper", "Standard", "Offensiv", "Sehr offensiv", "Legacy"].includes(r.account) ||
      typeof r.outcome !== "string" || !/^[A-Z_]{1,100}$/.test(r.outcome)) return [];
    const d = record(r.diagnostics);
    const fraction = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
    const diagnostics = d && fraction(d.completeness) && fraction(d.requiredCompleteness) && fraction(d.weightCoverage) ? {
      finalScore: typeof d.finalScore === "number" && Number.isFinite(d.finalScore) && d.finalScore >= 0 && d.finalScore <= 100 ? d.finalScore : null,
      completeness: d.completeness, requiredCompleteness: d.requiredCompleteness, weightCoverage: d.weightCoverage,
      missing: Array.isArray(d.missing) ? d.missing.slice(0, 50).flatMap((v: unknown) => {
        const m = record(v);
        return m && typeof m.field === "string" && /^[A-Za-z0-9.]{1,100}$/.test(m.field) &&
          typeof m.reason === "string" && /^[A-Z_]{1,100}$/.test(m.reason) ? [{ field: m.field, reason: m.reason }] : [];
      }) : [],
      unavailableScores: Array.isArray(d.unavailableScores) ? d.unavailableScores.filter((v): v is string => typeof v === "string" && /^[A-Za-z]{1,40}$/.test(v)) : [],
    } : undefined;
    return [{ mint: r.mint, account: r.account, outcome: r.outcome, ...(typeof r.detail === "string" ? { detail: r.detail.slice(0, 500) } : {}), ...(diagnostics ? { diagnostics } : {}) }];
  });
}
