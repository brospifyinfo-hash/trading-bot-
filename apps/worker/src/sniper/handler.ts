import { sharedMarketAdapters } from "../pipeline/shared-market-adapters";
import { and, eq } from "drizzle-orm";
import { systemClock } from "@sae/core";
import { loadEnv, paperCandidate, providerEnvSchema } from "@sae/config";
import { countSnapshots, JobQueueRepository, loadEntryScore, ProviderHealthStore, recordSecurityFinding, schema } from "@sae/db";
import { RugcheckReportAdapter } from "@sae/providers";
import { toStatusReports, type HandlerDeps } from "../handlers";
import type { JobHandler } from "../consumer";
import { ensurePaperCandidateVersion, usesPaperCandidate } from "../pipeline/paper-candidate-version";
import { toFinding } from "../pipeline/security-enrichment";
import { refreshMarketData } from "../pipeline/market-refresh";
import { runDecision } from "../pipeline/decision-run";
import { buildQuoteSource } from "../pipeline/quote-source";
import { buildPaperValuation } from "../pipeline/paper-valuation";
import { QUOTE_ANCHOR_MINT } from "../pipeline/quote-market-source";
import { parseLaunchEvent } from "./feed";

export function buildSniperHandler(deps: HandlerDeps): JobHandler {
  return { wiring: "DEDICATED", async handle(job) {
    if (!usesPaperCandidate(deps.env) || deps.env.PAPER_SNIPER_ENABLED === "false") return { status: "DISABLED" };
    const p = job.payload;
    const event = parseLaunchEvent(JSON.stringify({ mint: p.mint, txType: p.kind, signature: p.signature }), new Date());
    const receivedAt = typeof p.receivedAt === "string" ? new Date(p.receivedAt) : new Date(NaN);
    const age = Date.now() - receivedAt.getTime();
    if (!event || !Number.isFinite(age) || age < 0 || age > 600_000) return { status: "EXPIRED_EVENT" };
    const attempt = Number.isSafeInteger(p.attempt) && Number(p.attempt) >= 0 ? Number(p.attempt) : 0;
    const report = async (outcome: string, extra: Record<string, unknown> = {}, retry = false) => {
      if (retry && attempt < 4 && age < 480_000) {
        const at = new Date();
        await new JobQueueRepository(deps.db).enqueue({ kind: "PAPER_SNIPER", payload: { ...p, attempt: attempt + 1 },
          dedupeKey: `paper-sniper:${event.signature}:${attempt + 1}`, at,
          runAfter: new Date(at.getTime() + 60_000), priority: 50 });
      }
      return { status: outcome, mint: event.mint, event: event.kind, receivedAt: receivedAt.toISOString(),
        latencyMs: Date.now() - receivedAt.getTime(), attempt, ...extra };
    };
    await deps.db.insert(schema.tokens).values({ mint: event.mint, discoverySource: "pumpportal",
      firstSeenAt: receivedAt, state: "SCREENING" }).onConflictDoNothing();
    const [token] = await deps.db.select().from(schema.tokens).where(eq(schema.tokens.mint, event.mint)).limit(1);
    if (!token || token.blacklistedAt || token.state === "REJECTED") return report("TOKEN_BLOCKED");
    const [health, snapshotCount] = await Promise.all([
      new ProviderHealthStore(deps.db).latest(), countSnapshots(deps.db),
    ]);
    const env = loadEnv(providerEnvSchema, deps.env);
    if (!env.RUGCHECK_BASE_URL) return report("SECURITY_NOT_CONFIGURED");
    const security = new RugcheckReportAdapter({ clock: systemClock, baseUrl: env.RUGCHECK_BASE_URL });
    const finding = await security.fetchReport(event.mint);
    if (finding.kind !== "OK") return report(`SECURITY_${finding.kind}`, {}, true);
    if (finding.report.rugged) return report("SECURITY_RUGGED");
    await recordSecurityFinding(deps.db, toFinding(token.id, finding, security.schemaVersion), new Date());
    const adapters = sharedMarketAdapters(deps.adapters ?? new Map());
    const market = await refreshMarketData(`sniper-market:${job.id}`, { db: deps.db, logger: deps.logger,
      env: deps.env, clock: systemClock, adapters,
      statusOf: deps.statusOf ?? (() => "UNAVAILABLE"),
      tokens: [{ id: token.id, mint: token.mint }], maxUnitsPerRun: 1, maxTokens: 1 });
    if (!market.ingested) return report("WAITING_EXECUTABLE_MARKET", {}, true);
    const accounts: { account: string; status: string; score: number | null; detail?: string }[] = [];
    let retry = false;
    // Dieselbe Quelle wie der Bewertungslauf: die Datenbank. Haette der Sniper
    // seine eigene, koennte er mit einer anderen Schwelle einsteigen als die,
    // die im Dashboard steht.
    const schwelle = await loadEntryScore(deps.db);
    // Ein Konto. Vorher liefen hier drei Profile je Launch-Ereignis — dreimal
    // dieselbe Entscheidung auf denselben Daten, mit dreifachem Anfragebudget.
    for (const profile of [{ label: "Paper", candidate: paperCandidate(schwelle.score, schwelle.mode) }]) {
      const strategy = await ensurePaperCandidateVersion(deps.db, new Date(), profile.candidate);
      const [open] = await deps.db.select({ id: schema.paperPositions.id }).from(schema.paperPositions)
        .innerJoin(schema.strategyVersions, eq(schema.strategyVersions.id, schema.paperPositions.strategyVersionId))
        .innerJoin(schema.strategies, eq(schema.strategies.id, schema.strategyVersions.strategyId))
        .where(and(eq(schema.paperPositions.tokenId, token.id), eq(schema.strategies.name, profile.candidate.strategyId))).limit(1);
      if (open) { accounts.push({ account: profile.label, status: "ALREADY_TRADED", score: null }); continue; }
      // Eine geworfene Entscheidung darf den Sniper nicht ins Dead Letter
      // tragen: das Ereignis ist dann verloren, obwohl der Fehler an EINEM
      // Coin hing. Gezaehlt und benannt statt gescheitert.
      let result: Awaited<ReturnType<typeof runDecision>>;
      try {
        result = await runDecision({ db: deps.db, logger: deps.logger, env: deps.env,
        tokenId: token.id, mint: token.mint, firstSeenAt: token.firstSeenAt, strategyVersionId: strategy.id,
        snapshotCount, providerReports: toStatusReports(health),
        adapters, statusOf: deps.statusOf ?? (() => "UNAVAILABLE"),
        quotes: buildQuoteSource(env), loadValuation: buildPaperValuation(env),
        quoteMint: QUOTE_ANCHOR_MINT, entryAmountRaw: null, liquidityUsd: null,
      });
      } catch (error: unknown) {
        const klasse = error instanceof Error ? error.constructor.name : "Unknown";
        deps.logger.error({ role: "sniper", mint: token.mint, err: error },
          "Sniper-Entscheidung gescheitert — Ereignis bleibt aufgezeichnet");
        result = { outcome: "BLOCKED", detail: `Entscheidung warf ${klasse}`,
          label: `FEHLER_${klasse}`, finalScore: null, missing: [] };
      }
      accounts.push({ account: profile.label, status: result.label, score: result.finalScore, detail: result.detail });
      retry ||= result.outcome !== "ENTERED" && /INCOMPLETE|NO_SOURCE|LAUNCH_BUY_PRESSURE|QUOTE|NO_FEATURE|STALE/.test(result.label);
    }
    return report(accounts.some((a) => a.status === "ENTERED") ? "ENTERED" : "EVALUATED", { accounts }, retry);
  } };
}
