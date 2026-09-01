/**
 * Deployment-Smoke-Test: der ganze Weg, stufenweise.
 *
 * Beweist nach einem Deployment, wie weit das System tatsaechlich kommt:
 *
 *   REAL PROVIDER → REAL RESPONSE → SCHEMA VALIDATED → PRODUCTION_VERIFIED
 *   → MARKET SNAPSHOT → FEATURE OBSERVATION → DECISION → OPPORTUNITY
 *   → 100 EUR AUTO PAPER  +  MANUAL OPPORTUNITY
 *
 * Der Test simuliert nichts. Jede Stufe meldet PASS, FAIL oder BLOCKED mit
 * Grund, und der Lauf endet an der ersten Stufe, die nicht durchkommt. Ein
 * gruener Lauf bedeutet dann tatsaechlich, dass echte Daten bis zur
 * Paper-Position durchliefen.
 *
 * Die `console.log`-Ausgabe ist Absicht: das Skript ist ein
 * Kommandozeilenwerkzeug, sein Ergebnis IST seine Ausgabe.
 *
 * Ausfuehren:
 *   DATABASE_URL=... pnpm --filter @sae/worker exec tsx src/smoke/pipeline.ts <mint>
 */

/* eslint-disable no-console -- Kommandozeilenwerkzeug: die Ausgabe ist das Ergebnis. */
import { systemClock } from "@sae/core";
import {
  ProviderReadinessStore,
  SnapshotRepository,
  createDatabase,
  loadDiagnostics,
  schema,
  type Database,
} from "@sae/db";
import { DexScreenerMarketAdapter } from "@sae/providers";

export type StageOutcome = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface StageResult {
  readonly stage: string;
  readonly outcome: StageOutcome;
  readonly detail: string;
}

const CAPABILITY = "TOKEN_MARKET";
const PROVIDER = "dexscreener";

/**
 * Fuehrt die Stufen der Reihe nach aus.
 *
 * Bricht bei der ersten Stufe ab, die nicht PASS liefert — alles danach waere
 * eine Aussage ueber eine Voraussetzung, die nicht erfuellt ist.
 */
export async function runPipelineSmokeTest(input: {
  readonly db: Database;
  readonly mint: string;
}): Promise<readonly StageResult[]> {
  const results: StageResult[] = [];
  const push = (r: StageResult): StageResult => {
    results.push(r);
    return r;
  };

  /* ------------------------------------------------ 1. Anbietervertrag */
  const adapter = new DexScreenerMarketAdapter({ clock: systemClock });
  if (!adapter.contractVerified) {
    push({
      stage: "1. SCHEMA CONTRACT",
      outcome: "BLOCKED",
      detail:
        "Kein geprueftes Response-Schema. Benoetigt: eine echte Antwort von " +
        "GET /tokens/v1/solana/{address} oder eine offizielle Spezifikation. " +
        "Siehe docs/providers/dexscreener.md.",
    });
    return results;
  }
  push({
    stage: "1. SCHEMA CONTRACT",
    outcome: "PASS",
    detail: `Vertrag ${adapter.schemaVersion} verifiziert.`,
  });

  /* ------------------------------------------------ 2. Echter Abruf */
  const fetched = await adapter.fetchMarkets([input.mint]);
  const readiness = new ProviderReadinessStore(input.db);

  await readiness.recordRequest({
    providerId: PROVIDER,
    capability: CAPABILITY,
    endpoint: "/tokens/v1/{chainId}/{tokenAddresses}",
    at: systemClock.now(),
    latencyMs: fetched.latencyMs,
    httpStatus: fetched.kind === "FAILED" ? fetched.httpStatus : fetched.httpStatus,
    success: fetched.kind === "OK",
    failureClass: fetched.kind === "FAILED" ? fetched.failure : null,
    failureReason:
      fetched.kind === "FAILED"
        ? fetched.reason
        : fetched.kind === "SCHEMA_REJECTED"
          ? fetched.reason
          : null,
    pipelineStage: "SMOKE_TEST",
    schemaValid: fetched.kind === "OK" ? true : fetched.kind === "SCHEMA_REJECTED" ? false : null,
    tokensCovered: 1,
  });

  if (fetched.kind !== "OK") {
    const blocked = fetched.kind === "FAILED" && fetched.failure === "BLOCKED";
    push({
      stage: "2. REAL RESPONSE",
      outcome: blocked ? "BLOCKED" : "FAIL",
      detail:
        fetched.kind === "FAILED"
          ? `${fetched.failure}: ${fetched.reason}`
          : fetched.kind === "SCHEMA_REJECTED"
            ? `Schema abgelehnt: ${fetched.reason}`
            : "Anbieter kennt die Adresse nicht.",
    });
    return results;
  }
  push({
    stage: "2. REAL RESPONSE",
    outcome: "PASS",
    detail: `HTTP ${String(fetched.httpStatus)}, ${String(fetched.latencyMs)} ms, ${String(fetched.markets.length)} Datensatz/-saetze.`,
  });

  /* ------------------------------------------------ 3. PRODUCTION_VERIFIED */
  const status = await readiness.recordSmokeTest({
    providerId: PROVIDER,
    capability: CAPABILITY,
    at: systemClock.now(),
    httpStatus: fetched.httpStatus,
    detail: `${String(fetched.markets.length)} Datensatz/-saetze, Schema validiert`,
    schemaVerified: true,
  });
  push({
    stage: "3. PRODUCTION_VERIFIED",
    outcome: status?.productionVerified === true ? "PASS" : "FAIL",
    detail: `Zustand ${status?.state ?? "unbekannt"}.`,
  });
  if (status?.productionVerified !== true) return results;

  /* ------------------------------------------------ 4. Snapshot */
  const market = fetched.markets[0];
  if (market === undefined) {
    push({ stage: "4. MARKET SNAPSHOT", outcome: "FAIL", detail: "Keine Marktdaten im Ergebnis." });
    return results;
  }

  const [token] = await input.db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .limit(1);
  if (token === undefined) {
    push({
      stage: "4. MARKET SNAPSHOT",
      outcome: "BLOCKED",
      detail: "Kein Token in der Datenbank. Die Discovery muss zuerst laufen.",
    });
    return results;
  }

  const ingested = await new SnapshotRepository(input.db).ingest({
    tokenId: token.id as never,
    clock: systemClock,
    sourcedValue: {
      value: {
        priceUsd: market.priceUsd,
        liquidityUsd: market.liquidityUsd,
        marketCapUsd: market.marketCapUsd,
        volume24hUsd: market.volume24hUsd,
        holders: null,
      },
      // Ohne Anbieterzeitpunkt gilt der Abruf als Beobachtung. Das ist eine
      // bewusste Einstufung, keine Erfindung: der Tier faellt entsprechend.
      observedAt: market.observedAt ?? systemClock.now(),
      fetchedAt: systemClock.now(),
      providerId: PROVIDER as never,
      tier: market.observedAt === null ? "SECONDARY" : "PRIMARY",
      freshnessSeconds: 0,
    },
  });
  push({
    stage: "4. MARKET SNAPSHOT",
    outcome: ingested.kind === "REJECTED" ? "FAIL" : "PASS",
    detail:
      ingested.kind === "REJECTED"
        ? `Abgelehnt: ${ingested.decision.kind}`
        : `${ingested.kind}, Schluessel ${ingested.ingestKey.slice(0, 12)}...`,
  });
  if (ingested.kind === "REJECTED") return results;

  /* ------------------------------------------------ 5. Feature-Vektor */
  const snapshots = await new SnapshotRepository(input.db).countForToken(token.id);
  push({
    stage: "5. FEATURE VECTOR",
    outcome: "BLOCKED",
    detail:
      `${String(snapshots)} Snapshot(s) fuer diesen Token. Der Feature-Vektor entsteht aus ` +
      "der Historie ueber den PitReader; bis dahin BUILDING_HISTORY. Das ist kein " +
      "Fehler, sondern die Datenabhaengigkeit selbst.",
  });

  /* ---------------------- 6-8. Entscheidung, Gelegenheit, Paper ---------- */
  for (const stage of [
    "6. DECISION",
    "7. OPPORTUNITY (AUTO + MANUAL)",
    "8. 100 EUR AUTO PAPER",
  ]) {
    push({ stage, outcome: "SKIPPED", detail: "Setzt Stufe 5 voraus." });
  }

  return results;
}

async function main(): Promise<void> {
  const mint = process.argv[2];
  const url = process.env["DATABASE_URL"];

  if (mint === undefined) {
    console.error("Aufruf: tsx src/smoke/pipeline.ts <mint>");
    process.exit(2);
  }
  if (url === undefined || url.length === 0) {
    console.error("DATABASE_URL fehlt.");
    process.exit(2);
  }

  const db = createDatabase(url);
  const results = await runPipelineSmokeTest({ db, mint });

  console.log("\nDEPLOYMENT SMOKE TEST\n");
  for (const r of results) {
    const mark = { PASS: "PASS   ", FAIL: "FAIL   ", BLOCKED: "BLOCKED", SKIPPED: "SKIPPED" }[
      r.outcome
    ];
    console.log(`  [${mark}] ${r.stage}`);
    console.log(`            ${r.detail}`);
  }

  const diagnostics = await loadDiagnostics({ db, now: new Date() });
  console.log(`\nGesamt: ${diagnostics.headline}`);

  const failed = results.some((r) => r.outcome === "FAIL");
  const blocked = results.some((r) => r.outcome === "BLOCKED");
  // Getrennte Exit-Codes: ein Fehlschlag ist etwas anderes als eine Sperre.
  process.exit(failed ? 1 : blocked ? 3 : 0);
}

if (process.argv[1]?.endsWith("pipeline.ts") === true) {
  void main();
}
