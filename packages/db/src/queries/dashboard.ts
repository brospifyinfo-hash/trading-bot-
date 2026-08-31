import { desc, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../client";
import { tokenSnapshots } from "../schema/tokens";
import { opportunities, paperPositions } from "../schema/opportunities";
import { providerStatusSamples } from "../schema/pipeline";
import { strategyCandidates } from "../schema/research";

/**
 * Datenschicht des Dashboards.
 *
 * Eine Regel bestimmt die Form aller Typen hier: **ohne Daten keine Aussage.**
 * Deshalb ist jede Kachel ein `Panel<T>` und kein `T | null` — ein `null` wird
 * in der Anzeige irgendwann zu einer 0, und eine 0 sieht aus wie eine Messung.
 * Ein `Panel` zwingt die Oberflaeche, den Zustand zu unterscheiden:
 *
 *   DATA          es gibt etwas zu zeigen
 *   WAITING       es fehlt die Datenquelle
 *   INSUFFICIENT  es gibt Daten, aber zu wenige fuer eine Aussage
 *
 * Der dritte Fall ist der wichtigste: „12 Trades, Trefferquote 75 %" ist keine
 * Aussage, sondern Rauschen mit Nachkommastellen.
 */

export type Panel<T> =
  | { readonly kind: "DATA"; readonly value: T }
  | { readonly kind: "WAITING"; readonly reason: string }
  | { readonly kind: "INSUFFICIENT"; readonly have: number; readonly need: number; readonly reason: string };

export const waiting = <T>(reason: string): Panel<T> => ({ kind: "WAITING", reason });
export const insufficient = <T>(have: number, need: number, reason: string): Panel<T> => ({
  kind: "INSUFFICIENT",
  have,
  need,
  reason,
});
export const data = <T>(value: T): Panel<T> => ({ kind: "DATA", value });

/* ------------------------------------------------------------- Provider */

export interface ProviderRow {
  readonly providerId: string;
  readonly kind: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly observedAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureReason: string | null;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitLimit: number | null;
  readonly rateLimitResetAt: Date | null;
  readonly dataFreshnessSeconds: number | null;
  readonly detail: string | null;
}

/**
 * Letzter bekannter Stand je Provider.
 *
 * `DISTINCT ON` statt einer Unterabfrage je Anbieter: die Tabelle waechst mit
 * jeder Messung, und ein Dashboard, das sie bei jedem Aufruf mehrfach scannt,
 * wird mit der Zeit langsam, ohne dass jemand die Ursache sucht.
 */
export async function loadProviderStatus(db: Database): Promise<readonly ProviderRow[]> {
  const rows = await db
    .select()
    .from(providerStatusSamples)
    .orderBy(providerStatusSamples.providerId, desc(providerStatusSamples.observedAt));

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latest.has(row.providerId)) latest.set(row.providerId, row);
  }

  return [...latest.values()].map((r) => ({
    providerId: r.providerId,
    kind: r.kind,
    status: r.status,
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
    observedAt: r.observedAt,
    lastSuccessAt: r.lastSuccessAt,
    lastFailureAt: r.lastFailureAt,
    lastFailureReason: r.lastFailureReason,
    latencyMsP50: r.latencyMsP50,
    latencyMsP95: r.latencyMsP95,
    rateLimitRemaining: r.rateLimitRemaining,
    rateLimitLimit: r.rateLimitLimit,
    rateLimitResetAt: r.rateLimitResetAt,
    dataFreshnessSeconds: r.dataFreshnessSeconds,
    detail: r.detail,
  }));
}

/* ------------------------------------------------------------- Ingestion */

export interface IngestionSummary {
  readonly snapshotCount: number;
  readonly lastSnapshotAt: Date | null;
  readonly distinctTokens: number;
  /** Verteilung nach Qualitaetsstufe. Ein Fallback-lastiger Bestand ist ein Befund. */
  readonly byTier: Readonly<Record<string, number>>;
}

export async function loadIngestionSummary(
  db: Database,
  since: Date | null = null,
): Promise<IngestionSummary> {
  const where = since === null ? undefined : gte(tokenSnapshots.observedAt, since);

  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${tokenSnapshots.observedAt})`,
      tokens: sql<number>`count(distinct ${tokenSnapshots.tokenId})::int`,
    })
    .from(tokenSnapshots)
    .where(where);

  const tiers = await db
    .select({
      tier: tokenSnapshots.sourceTier,
      count: sql<number>`count(*)::int`,
    })
    .from(tokenSnapshots)
    .where(where)
    .groupBy(tokenSnapshots.sourceTier);

  const byTier: Record<string, number> = {};
  for (const row of tiers) byTier[row.tier ?? "UNKNOWN"] = row.count;

  return {
    snapshotCount: totals?.count ?? 0,
    lastSnapshotAt: totals?.lastAt ?? null,
    distinctTokens: totals?.tokens ?? 0,
    byTier,
  };
}

/* ---------------------------------------------------------- Paper Trading */

export interface PaperSummary {
  readonly stream: string;
  readonly sizingMode: string;
  readonly closedPositions: number;
  readonly openPositions: number;
}

/**
 * Zaehlt Paper-Positionen je Strom und Sizing-Verfahren.
 *
 * Bewusst nur Zaehlungen, keine Trefferquote: die Kennzahlen kommen aus
 * `@sae/analytics` und sind dort an eine Mindeststichprobe gebunden. Eine
 * zweite Rechenstelle in der Datenschicht waere die erste Gelegenheit, diese
 * Bindung zu verlieren.
 */
export async function loadPaperSummary(db: Database): Promise<readonly PaperSummary[]> {
  const rows = await db
    .select({
      stream: paperPositions.stream,
      sizingMode: paperPositions.sizingMode,
      closed: sql<number>`count(*) filter (where ${paperPositions.closedAt} is not null)::int`,
      open: sql<number>`count(*) filter (where ${paperPositions.closedAt} is null)::int`,
    })
    .from(paperPositions)
    .groupBy(paperPositions.stream, paperPositions.sizingMode);

  return rows.map((r) => ({
    stream: r.stream,
    sizingMode: r.sizingMode,
    closedPositions: r.closed,
    openPositions: r.open,
  }));
}

export interface OpportunityCounts {
  readonly byState: Readonly<Record<string, number>>;
  readonly total: number;
}

export async function loadOpportunityCounts(db: Database): Promise<OpportunityCounts> {
  const rows = await db
    .select({ state: opportunities.state, count: sql<number>`count(*)::int` })
    .from(opportunities)
    .groupBy(opportunities.state);

  const byState: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byState[row.state] = row.count;
    total += row.count;
  }
  return { byState, total };
}

/* -------------------------------------------------------------- Research */

export interface ResearchSummary {
  readonly candidatesByState: Readonly<Record<string, number>>;
  readonly promotedCount: number;
}

export async function loadResearchSummary(db: Database): Promise<ResearchSummary> {
  const rows = await db
    .select({ state: strategyCandidates.state, count: sql<number>`count(*)::int` })
    .from(strategyCandidates)
    .groupBy(strategyCandidates.state);

  const candidatesByState: Record<string, number> = {};
  for (const row of rows) candidatesByState[row.state] = row.count;

  const [promoted] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(strategyCandidates)
    .where(eq(strategyCandidates.state, "PROMOTED"));

  return { candidatesByState, promotedCount: promoted?.count ?? 0 };
}

/* ------------------------------------------------------------ Gesamtbild */

export interface DashboardThresholds {
  /** Ab wie vielen Snapshots ueberhaupt bewertet wird. */
  readonly minSnapshotsForAnalysis: number;
  /** Ab wie vielen abgeschlossenen Paper-Trades eine Kennzahl gezeigt wird. */
  readonly minClosedForStatistics: number;
}

export const DEFAULT_DASHBOARD_THRESHOLDS: DashboardThresholds = {
  minSnapshotsForAnalysis: 100,
  minClosedForStatistics: 100,
};

export interface DashboardState {
  readonly providers: readonly ProviderRow[];
  readonly marketDataConnected: boolean;
  readonly ingestion: Panel<IngestionSummary>;
  readonly paper: Panel<readonly PaperSummary[]>;
  readonly opportunities: Panel<OpportunityCounts>;
  readonly research: Panel<ResearchSummary>;
  readonly headline: string;
  readonly generatedAt: Date;
}

/**
 * Ein Aufruf, ein Bild.
 *
 * Die Kacheln haengen voneinander ab: ohne Marktdaten gibt es keine Snapshots,
 * ohne Snapshots keine Gelegenheiten, ohne abgeschlossene Positionen keine
 * Statistik. Die Reihenfolge der Pruefungen bildet genau diese Kette ab, damit
 * die Anzeige die ERSTE fehlende Voraussetzung nennt und nicht die letzte.
 */
export async function loadDashboardState(input: {
  readonly db: Database;
  readonly now: Date;
  readonly thresholds?: DashboardThresholds;
}): Promise<DashboardState> {
  const thresholds = input.thresholds ?? DEFAULT_DASHBOARD_THRESHOLDS;
  const providers = await loadProviderStatus(input.db);

  const marketProviders = providers.filter((p) => p.capabilities.includes("TOKEN_MARKET"));
  const marketDataConnected = marketProviders.some((p) => p.status === "CONNECTED");

  const ingestion = await loadIngestionSummary(input.db);
  const opportunityCounts = await loadOpportunityCounts(input.db);
  const paperRows = await loadPaperSummary(input.db);
  const research = await loadResearchSummary(input.db);

  const closedTotal = paperRows.reduce((sum, r) => sum + r.closedPositions, 0);

  const noSourceReason =
    marketProviders.length === 0
      ? "Keine Marktdatenquelle konfiguriert."
      : marketProviders.every((p) => p.status === "BLOCKED")
        ? "Alle Marktdatenquellen vom Netz gesperrt."
        : "Keine Marktdatenquelle verbunden.";

  const ingestionPanel: Panel<IngestionSummary> =
    ingestion.snapshotCount === 0
      ? waiting(noSourceReason)
      : ingestion.snapshotCount < thresholds.minSnapshotsForAnalysis
        ? insufficient(
            ingestion.snapshotCount,
            thresholds.minSnapshotsForAnalysis,
            "Historie wird aufgebaut.",
          )
        : data(ingestion);

  const opportunityPanel: Panel<OpportunityCounts> =
    opportunityCounts.total === 0
      ? waiting(
          ingestion.snapshotCount === 0
            ? noSourceReason
            : "Noch keine Gelegenheit bewertet.",
        )
      : data(opportunityCounts);

  const paperPanel: Panel<readonly PaperSummary[]> =
    paperRows.length === 0
      ? waiting(opportunityCounts.total === 0 ? noSourceReason : "Noch keine Paper-Position eroeffnet.")
      : closedTotal < thresholds.minClosedForStatistics
        ? insufficient(
            closedTotal,
            thresholds.minClosedForStatistics,
            "Zu wenige abgeschlossene Trades fuer eine Kennzahl.",
          )
        : data(paperRows);

  const researchPanel: Panel<ResearchSummary> =
    Object.keys(research.candidatesByState).length === 0
      ? waiting("Noch kein Strategie-Kandidat — dafuer braucht es abgeschlossene Trades.")
      : data(research);

  return {
    providers,
    marketDataConnected,
    ingestion: ingestionPanel,
    paper: paperPanel,
    opportunities: opportunityPanel,
    research: researchPanel,
    headline: marketDataConnected
      ? ingestionPanel.kind === "DATA"
        ? "Pipeline laeuft."
        : "Historie wird aufgebaut."
      : "WAITING FOR LIVE MARKET DATA",
    generatedAt: input.now,
  };
}
