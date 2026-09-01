import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import type { Database } from "../client";
import { tokenSnapshots } from "../schema/tokens";
import { opportunities, paperPositions } from "../schema/opportunities";
import { providerStatusSamples } from "../schema/pipeline";
import { strategyCandidates } from "../schema/research";
import { jobQueue, jobQueueHistory } from "../schema/queue";
import { latencySamples } from "../schema/latency";
import { systemEvents } from "../schema/ops";

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
export async function loadPaperSummary(
  db: Database,
  /**
   * Welche Herkunft gezaehlt wird.
   *
   * Pflichtparameter, kein Standardwert. Ein Standard waere die Stelle, an der
   * jemand spaeter unbemerkt Testdaten in eine Produktionskachel bekommt — die
   * Aufrufstelle muss sich entscheiden.
   */
  scope: DataScope,
): Promise<readonly PaperSummary[]> {
  const rows = await db
    .select({
      stream: paperPositions.stream,
      sizingMode: paperPositions.sizingMode,
      closed: sql<number>`count(*) filter (where ${paperPositions.closedAt} is not null)::int`,
      open: sql<number>`count(*) filter (where ${paperPositions.closedAt} is null)::int`,
    })
    .from(paperPositions)
    .where(eq(paperPositions.isTestFixture, scope === "TEST"))
    .groupBy(paperPositions.stream, paperPositions.sizingMode);

  return rows.map((r) => ({
    stream: r.stream,
    sizingMode: r.sizingMode,
    closedPositions: r.closed,
    openPositions: r.open,
  }));
}

/**
 * Produktion oder Test — die Trennung, die jede Abfrage treffen muss.
 *
 * PRODUCTION zaehlt ausschliesslich Datensaetze mit echter Herkunft. TEST zeigt
 * die Fixture-Daten in einem eigenen Bereich, damit sie sichtbar sind, ohne je
 * als Handelsleistung zu erscheinen.
 */
export type DataScope = "PRODUCTION" | "TEST";

export interface OpportunityCounts {
  readonly byState: Readonly<Record<string, number>>;
  readonly total: number;
}

export async function loadOpportunityCounts(
  db: Database,
  scope: DataScope,
): Promise<OpportunityCounts> {
  const rows = await db
    .select({ state: opportunities.state, count: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(eq(opportunities.isTestFixture, scope === "TEST"))
    .groupBy(opportunities.state);

  const byState: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byState[row.state] = row.count;
    total += row.count;
  }
  return { byState, total };
}

/* ------------------------------------------------------ Jobs und Queue */

/**
 * Betriebszustand der Queue.
 *
 * Die Zahlen, an denen sich sehen laesst, ob der Bot tatsaechlich autonom
 * laeuft — und nicht nur laeuft. Ein Prozess ohne Dead Letters und ohne
 * abgeschlossene Auftraege tut naemlich gar nichts.
 */
export interface QueueSummary {
  readonly queued: number;
  readonly running: number;
  readonly done: number;
  readonly dead: number;
  /** Aeltester wartender Auftrag. `null`, wenn keiner wartet. */
  readonly oldestQueuedAt: Date | null;
  readonly retryingJobs: number;
}

export async function loadQueueSummary(db: Database): Promise<QueueSummary> {
  const live = await db
    .select({
      state: jobQueue.state,
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${jobQueue.enqueuedAt})`,
      retrying: sql<number>`count(*) filter (where ${jobQueue.attempts} > 1)::int`,
    })
    .from(jobQueue)
    .groupBy(jobQueue.state);

  const history = await db
    .select({ state: jobQueueHistory.state, count: sql<number>`count(*)::int` })
    .from(jobQueueHistory)
    .groupBy(jobQueueHistory.state);

  const liveBy = (state: string): number => live.find((r) => r.state === state)?.count ?? 0;
  const doneHistory = history.find((r) => r.state === "DONE")?.count ?? 0;
  const oldest = live.find((r) => r.state === "QUEUED")?.oldest ?? null;

  return {
    queued: liveBy("QUEUED"),
    running: liveBy("RUNNING"),
    done: doneHistory,
    dead: liveBy("DEAD"),
    oldestQueuedAt: oldest === null ? null : new Date(oldest),
    retryingJobs: live.reduce((n, r) => n + r.retrying, 0),
  };
}

export interface JobRow {
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly failureClass: string | null;
  readonly enqueuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Dauer in Millisekunden. `null`, solange der Auftrag laeuft. */
  readonly durationMs: number | null;
}

/**
 * Die zuletzt beendeten und die gescheiterten Auftraege.
 *
 * Bewusst Einzelzeilen und keine Durchschnittsdauer: ein Mittelwert glaettet
 * genau den einen Lauf weg, der zwanzig Minuten brauchte — und der ist der
 * interessante.
 */
export async function loadRecentJobs(db: Database, limit = 20): Promise<readonly JobRow[]> {
  const rows = await db
    .select({
      kind: jobQueue.kind,
      state: jobQueue.state,
      attempts: jobQueue.attempts,
      lastError: jobQueue.lastError,
      failureClass: jobQueue.lastFailureClass,
      enqueuedAt: jobQueue.enqueuedAt,
      startedAt: jobQueue.startedAt,
      finishedAt: jobQueue.finishedAt,
    })
    .from(jobQueue)
    .orderBy(desc(jobQueue.enqueuedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    durationMs:
      r.startedAt === null || r.finishedAt === null
        ? null
        : r.finishedAt.getTime() - r.startedAt.getTime(),
  }));
}

/** Auftraege, die endgueltig gescheitert sind. Sie verschwinden nicht. */
export async function loadDeadLetters(db: Database, limit = 20): Promise<readonly JobRow[]> {
  const rows = await db
    .select({
      kind: jobQueue.kind,
      state: jobQueue.state,
      attempts: jobQueue.attempts,
      lastError: jobQueue.lastError,
      failureClass: jobQueue.lastFailureClass,
      enqueuedAt: jobQueue.enqueuedAt,
      startedAt: jobQueue.startedAt,
      finishedAt: jobQueue.finishedAt,
    })
    .from(jobQueue)
    .where(eq(jobQueue.state, "DEAD"))
    .orderBy(desc(jobQueue.finishedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    durationMs:
      r.startedAt === null || r.finishedAt === null
        ? null
        : r.finishedAt.getTime() - r.startedAt.getTime(),
  }));
}

/* ---------------------------------------------------- Verpasste Chancen */

export interface MissedSummary {
  /** Abgelaufen, ohne dass der Nutzer reagiert hat. */
  readonly expired: number;
  /** Bewusst abgelehnt — sagt etwas ueber die Strategie, nicht ueber Erreichbarkeit. */
  readonly rejected: number;
  /** Nutzer war da, die Revalidierung scheiterte. */
  readonly invalidated: number;
  readonly cancelled: number;
}

/**
 * Gelegenheiten, die keine Position erzeugt haben.
 *
 * Getrennt gefuehrt, weil sie Verschiedenes bedeuten: eine abgelaufene sagt
 * etwas ueber die Erreichbarkeit des Nutzers, eine abgelehnte etwas ueber die
 * Strategie. In einen Topf geworfen wird aus einem Verfuegbarkeitsproblem ein
 * Strategiefehler.
 *
 * Und in keinem Fall ein Verlust: keine dieser Zeilen traegt einen Betrag.
 */
export async function loadMissedSummary(
  db: Database,
  scope: DataScope,
): Promise<MissedSummary> {
  const rows = await db
    .select({ state: opportunities.state, count: sql<number>`count(*)::int` })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.isTestFixture, scope === "TEST"),
        eq(opportunities.stream, "MANUAL_PAPER"),
      ),
    )
    .groupBy(opportunities.state);

  const by = (state: string): number => rows.find((r) => r.state === state)?.count ?? 0;
  return {
    expired: by("EXPIRED"),
    rejected: by("REJECTED"),
    invalidated: by("INVALIDATED"),
    cancelled: by("CANCELLED"),
  };
}

/* ----------------------------------------------------------- Latenz */

export interface LatencySummaryRow {
  readonly stream: string;
  readonly samples: number;
  /** Median Beobachtung → Entscheidung, in Millisekunden. */
  readonly medianObservedToDecidedMs: number | null;
}

export async function loadLatencySummary(db: Database): Promise<readonly LatencySummaryRow[]> {
  const rows = await db
    .select({
      stream: latencySamples.stream,
      samples: sql<number>`count(*)::int`,
      median: sql<number | null>`percentile_cont(0.5) within group (
        order by extract(epoch from (${latencySamples.decidedAt} - ${latencySamples.observedAt})) * 1000
      )`,
    })
    .from(latencySamples)
    .where(and(isNotNull(latencySamples.observedAt), isNotNull(latencySamples.decidedAt)))
    .groupBy(latencySamples.stream);

  return rows.map((r) => ({
    stream: r.stream,
    samples: r.samples,
    // Ausdruecklich `null` und nicht 0, wenn nichts gemessen wurde.
    medianObservedToDecidedMs: r.median === null ? null : Number(r.median),
  }));
}

/* ----------------------------------------------------------- Fehler */

export interface ErrorRow {
  readonly kind: string;
  readonly severity: string;
  readonly at: Date;
  readonly detail: string;
}

/**
 * Betriebsfehler aus zwei Quellen: gescheiterte Auftraege und Systemereignisse.
 *
 * Zusammengefuehrt, weil beim Hinsehen die Frage „was ist kaputt" lautet und
 * nicht „welche Tabelle".
 */
export async function loadErrors(db: Database, limit = 20): Promise<readonly ErrorRow[]> {
  const dead = await db
    .select({
      kind: jobQueue.kind,
      at: jobQueue.finishedAt,
      detail: jobQueue.lastError,
      failureClass: jobQueue.lastFailureClass,
    })
    .from(jobQueue)
    .where(eq(jobQueue.state, "DEAD"))
    .orderBy(desc(jobQueue.finishedAt))
    .limit(limit);

  const events = await db
    .select({
      kind: systemEvents.kind,
      at: systemEvents.at,
      detail: systemEvents.detail,
    })
    .from(systemEvents)
    .orderBy(desc(systemEvents.at))
    .limit(limit);

  const rows: ErrorRow[] = [
    ...dead
      .filter((d) => d.at !== null)
      .map((d) => ({
        kind: `JOB:${d.kind}`,
        severity: "critical",
        at: d.at!,
        detail: `${d.failureClass ?? "UNKNOWN"}: ${d.detail ?? "ohne Begruendung"}`,
      })),
    ...events.map((e) => ({
      kind: e.kind,
      // system_events fuehrt keine Schwere; sie hier zu erfinden waere eine
      // Behauptung ueber die Wichtigkeit, die die Daten nicht hergeben.
      severity: "info",
      at: e.at,
      detail: JSON.stringify(e.detail),
    })),
  ];

  return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
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

/**
 * Wie lange eine Provider-Messung her sein darf, damit der Worker als lebendig
 * gilt. Der Takt schreibt jede Minute; drei Minuten lassen einen Aussetzer zu,
 * ohne einen echten Ausfall zu verschleiern.
 */
const WORKER_ALIVE_WINDOW_MS = 180_000;

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
  /** Verpasste und abgelehnte Manual-Gelegenheiten. Nie ein Betrag. */
  readonly missed: Panel<MissedSummary>;
  /** Betriebszustand der Queue: laeuft der Bot ueberhaupt? */
  readonly queue: QueueSummary;
  readonly recentJobs: readonly JobRow[];
  readonly deadLetters: readonly JobRow[];
  readonly errors: readonly ErrorRow[];
  readonly latency: Panel<readonly LatencySummaryRow[]>;
  readonly systemState: SystemStateRow;
  /** Champion/Challenger — solange kein Kandidat durch ist: NO EDGE VALIDATED. */
  readonly championChallenger: Panel<ChampionChallenger>;
  /**
   * Was aus Test-Fixtures stammt — separat, nie mit den obigen verrechnet.
   *
   * `null`, wenn es nichts gibt: dann erscheint der Bereich gar nicht erst,
   * statt eine leere Kachel mit Nullen zu zeigen.
   */
  readonly testData: TestDataSummary | null;
  readonly headline: string;
  readonly generatedAt: Date;
}

/**
 * Betriebszustand in einer Zeile.
 *
 * Beantwortet die Frage, mit der jeder auf das Dashboard schaut: laeuft das
 * Ding, und wenn nein, woran haengt es?
 */
export interface SystemStateRow {
  readonly phase: "WAITING_FOR_MARKET_DATA" | "BUILDING_HISTORY" | "RUNNING";
  readonly marketDataConnected: boolean;
  readonly workerAlive: boolean;
  /** Letzte Provider-Messung. `null` = der Worker hat nie geschrieben. */
  readonly lastProviderSampleAt: Date | null;
  readonly liveTradingEnabled: boolean;
  readonly blockedBy: readonly string[];
}

export interface ChampionChallenger {
  readonly champion: string | null;
  readonly challengers: number;
  readonly promoted: number;
}

/** Entwicklungsdaten. Ausdruecklich keine Handelsleistung. */
export interface TestDataSummary {
  readonly opportunities: OpportunityCounts;
  readonly paper: readonly PaperSummary[];
  readonly note: string;
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
  // Die Produktionskacheln zaehlen ausschliesslich echte Herkunft.
  const opportunityCounts = await loadOpportunityCounts(input.db, "PRODUCTION");
  const paperRows = await loadPaperSummary(input.db, "PRODUCTION");
  const research = await loadResearchSummary(input.db);

  // Getrennt daneben: was aus Test-Fixtures entstanden ist. Sichtbar, damit ein
  // Entwicklungslauf nachvollziehbar bleibt — aber niemals in derselben Zahl.
  const testOpportunities = await loadOpportunityCounts(input.db, "TEST");
  const testPaperRows = await loadPaperSummary(input.db, "TEST");

  const queue = await loadQueueSummary(input.db);
  const recentJobs = await loadRecentJobs(input.db);
  const deadLetters = await loadDeadLetters(input.db);
  const errors = await loadErrors(input.db);
  const latencyRows = await loadLatencySummary(input.db);
  const missed = await loadMissedSummary(input.db, "PRODUCTION");

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

  const testTotal =
    testOpportunities.total + testPaperRows.reduce((n, r) => n + r.openPositions + r.closedPositions, 0);
  const testData: TestDataSummary | null =
    testTotal === 0
      ? null
      : {
          opportunities: testOpportunities,
          paper: testPaperRows,
          note: "TEST / DEVELOPMENT DATA — aus Test-Fixtures. Keine Handelsleistung, keine Datenquelle, keine Grundlage fuer eine Freigabe.",
        };

  const missedTotal = missed.expired + missed.rejected + missed.invalidated + missed.cancelled;
  const missedPanel: Panel<MissedSummary> =
    opportunityCounts.total === 0
      ? waiting(noSourceReason)
      : missedTotal === 0
        ? waiting("Noch keine Manual-Gelegenheit abgeschlossen.")
        : data(missed);

  const latencyPanel: Panel<readonly LatencySummaryRow[]> =
    latencyRows.length === 0
      ? waiting("Noch keine Zeitstempelkette aufgezeichnet.")
      : data(latencyRows);

  // Champion/Challenger: solange kein Kandidat alle Gates bestanden hat, gibt
  // es keinen Champion — und ausdruecklich keinen Platzhalter, der so aussieht.
  const championPanel: Panel<ChampionChallenger> =
    research.promotedCount === 0
      ? waiting("NO EDGE VALIDATED — kein Kandidat hat alle Gates bestanden.")
      : data({
          champion: null,
          challengers: Object.values(research.candidatesByState).reduce((a, b) => a + b, 0),
          promoted: research.promotedCount,
        });

  const lastSample = providers.reduce<Date | null>(
    (latest, p) =>
      p.observedAt !== null && (latest === null || p.observedAt > latest) ? p.observedAt : latest,
    null,
  );

  const systemState: SystemStateRow = {
    phase: !marketDataConnected
      ? "WAITING_FOR_MARKET_DATA"
      : ingestion.snapshotCount < thresholds.minSnapshotsForAnalysis
        ? "BUILDING_HISTORY"
        : "RUNNING",
    marketDataConnected,
    // „Lebt der Worker?" heisst: hat er in den letzten Minuten etwas
    // geschrieben. Ein Prozess, der laeuft und nichts tut, gilt nicht als
    // lebendig — genau diese Verwechslung soll die Anzeige verhindern.
    workerAlive:
      lastSample !== null &&
      input.now.getTime() - lastSample.getTime() < WORKER_ALIVE_WINDOW_MS,
    lastProviderSampleAt: lastSample,
    liveTradingEnabled: false,
    blockedBy: marketDataConnected ? [] : [noSourceReason],
  };

  return {
    testData,
    missed: missedPanel,
    queue,
    recentJobs,
    deadLetters,
    errors,
    latency: latencyPanel,
    systemState,
    championChallenger: championPanel,
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
