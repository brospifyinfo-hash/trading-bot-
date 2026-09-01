/**
 * Smoke-Test gegen die echte DexScreener-API.
 *
 * Er simuliert nichts. Entweder es kommt eine Antwort, oder der Test meldet
 * einen Fehlschlag mit Grund — und `PRODUCTION_VERIFIED` bleibt `false`.
 *
 * Warum dieser Test kein Vitest-Test ist: ein Test, der Netzzugang braucht,
 * gehoert nicht in eine Suite, die bei jedem Commit laeuft. Er wird von Hand
 * ausgefuehrt, wenn ein Zugang existiert, und traegt sein Ergebnis in
 * `provider_capability_status` ein.
 *
 * Die `console.log`-Ausgabe ist hier bewusst: dieses Skript ist ein
 * Kommandozeilenwerkzeug, und sein Ergebnis IST seine Ausgabe. Ein Logger mit
 * Redaction wuerde die Antwort unlesbar machen, die zu pruefen der Zweck ist.
 *
 * Ausfuehren:
 *   pnpm --filter @sae/worker exec tsx src/smoke/dexscreener.ts <mint>
 *
 * WICHTIG: Solange der Vertrag nicht aus einer Primaerquelle verifiziert ist,
 * kann dieser Test nur `CONNECTED` erreichen, nicht `CAPABILITY_READY`. Er
 * prueft dann Erreichbarkeit und Antwortform, nicht deren Bedeutung.
 */

/* eslint-disable no-console -- Kommandozeilenwerkzeug: die Ausgabe ist das Ergebnis. */
import { ProviderReadinessStore, createDatabase } from "@sae/db";
import { classifyFailure } from "@sae/providers";

/** Aus der Spezifikation V1 uebernommen. Nicht aus einer Primaerquelle geprueft. */
const BASE_URL = "https://api.dexscreener.com";
const ENDPOINT = "/tokens/v1/solana/{tokenAddresses}";
const CAPABILITY = "TOKEN_MARKET";
const PROVIDER = "dexscreener";
const TIMEOUT_MS = 15_000;

export interface SmokeResult {
  readonly reachable: boolean;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly detail: string;
  /** Roher Antwortanfang, gekuerzt. Nur zur Diagnose, wird nicht gespeichert. */
  readonly preview: string | null;
}

/**
 * Fuehrt genau einen echten Request aus.
 *
 * Kein Retry: ein Smoke-Test soll den Zustand zeigen, nicht ihn schoenreden.
 */
export async function runSmokeTest(mint: string): Promise<SmokeResult> {
  const url = `${BASE_URL}${ENDPOINT.replace("{tokenAddresses}", mint)}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const body = await response.text();

    return {
      reachable: true,
      httpStatus: response.status,
      latencyMs,
      detail: response.ok
        ? `HTTP ${String(response.status)}, ${String(body.length)} Bytes`
        : `HTTP ${String(response.status)}: ${body.slice(0, 200)}`,
      preview: body.slice(0, 2_000),
    };
  } catch (error: unknown) {
    return {
      reachable: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
      preview: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const mint = process.argv[2];
  if (mint === undefined) {
    console.error("Aufruf: tsx src/smoke/dexscreener.ts <mint>");
    process.exit(2);
  }

  const result = await runSmokeTest(mint);
  console.log(JSON.stringify({ ...result, preview: undefined }, null, 2));
  if (result.preview !== null) {
    console.log("\n--- Antwortanfang (zur Schema-Verifikation) ---\n");
    console.log(result.preview);
  }

  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    console.error("\nDATABASE_URL fehlt — Ergebnis wird nicht festgehalten.");
    process.exit(result.reachable ? 0 : 1);
  }

  const store = new ProviderReadinessStore(createDatabase(url));
  await store.declare({
    providerId: PROVIDER,
    capability: CAPABILITY,
    // Bleibt SCHEMA_KNOWN, bis der Vertrag aus einer Primaerquelle stammt.
    // Ein erfolgreicher Request beweist Erreichbarkeit, nicht Bedeutung.
    implementationConfidence: "SCHEMA_KNOWN",
  });

  const succeeded = result.reachable && result.httpStatus !== null && result.httpStatus < 400;

  // Die Einordnung kommt aus derselben Funktion wie im Adapter. Eine zweite
  // Klassifikation hier waere eine zweite Wahrheit — und war genau der Fehler,
  // den dieser Test hatte: eine erreichbare Antwort mit HTTP 403 ergab
  // `success: false` bei `failureClass: null` und verletzte damit den
  // Constraint `provider_requests_failure_has_reason`. Das Skript stuerzte also
  // in genau dem Fall ab, fuer dessen Diagnose es gebaut wurde.
  const failureClass = succeeded
    ? null
    : classifyFailure(
        result.httpStatus === null
          ? { message: result.detail }
          : { httpStatus: result.httpStatus, message: result.detail },
      );

  await store.recordRequest({
    providerId: PROVIDER,
    capability: CAPABILITY,
    endpoint: ENDPOINT,
    at: new Date(),
    latencyMs: result.latencyMs,
    httpStatus: result.httpStatus,
    success: succeeded,
    failureClass,
    // Ein Fehlschlag ohne Grund ist eine verlorene Diagnose.
    failureReason: succeeded ? null : result.detail,
    pipelineStage: "SMOKE_TEST",
    tokensCovered: 1,
  });

  if (result.httpStatus !== null) {
    const status = await store.recordSmokeTest({
      providerId: PROVIDER,
      capability: CAPABILITY,
      at: new Date(),
      httpStatus: result.httpStatus,
      detail: result.detail,
      // Ausdruecklich `false`: der Vertrag ist nicht verifiziert. Damit bleibt
      // der Anbieter bei CONNECTED und erreicht kein CAPABILITY_READY.
      schemaVerified: false,
    });
    console.log("\nZustand:", JSON.stringify(status, null, 2));
  }

  // Dieselben Exit-Codes wie die uebrigen Smoke-Tests: 0 Erfolg, 1 Fehlschlag,
  // 3 Sperre. Eine Sperre als 0 zu melden waere die gefaehrlichste Variante —
  // ein Deployment-Skript haette sie fuer Erfolg gehalten.
  process.exit(succeeded ? 0 : failureClass === "BLOCKED" ? 3 : 1);
}

if (process.argv[1]?.endsWith("dexscreener.ts") === true) {
  void main();
}
