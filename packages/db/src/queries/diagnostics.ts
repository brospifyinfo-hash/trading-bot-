import { desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client";
import { providerCapabilityStatus, providerRequests } from "../schema/provider-readiness";
import { providerStatusSamples } from "../schema/pipeline";

/**
 * Was nach einem Deployment tatsaechlich pruefbar ist.
 *
 * Der Endpunkt beantwortet genau eine Frage: **kommt dieses System an Daten?**
 * Und zwar so, dass die Antwort ohne Kenntnis des Codes lesbar ist.
 *
 * Was hier NICHT erscheint: Verbindungszeichenfolgen, API-Schluessel,
 * Anbieter-Rohantworten. Der Endpunkt ist zur Diagnose da, nicht als
 * Nebeneingang in die Konfiguration.
 */

export interface ProviderDiagnostic {
  readonly providerId: string;
  readonly capability: string;
  readonly state: string;
  readonly implementationConfidence: string;
  readonly productionVerified: boolean;
  readonly schemaValidated: boolean | null;
  /** Letzter Smoke-Test: wann, mit welchem Status, mit welcher Auskunft. */
  readonly lastSmokeTestAt: Date | null;
  readonly lastSmokeTestStatus: number | null;
  readonly lastSmokeTestDetail: string | null;
  /** Letzte Antwort mit Erfolg. `null` = noch nie eine bekommen. */
  readonly lastSuccessAt: Date | null;
  readonly lastSuccessLatencyMs: number | null;
  readonly lastFailureAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly lastFailureReason: string | null;
  readonly requestsLastHour: number;
  readonly errorRateLastHour: number | null;
}

export interface ChainDiagnostic {
  readonly capability: string;
  /** Anbieter in der Reihenfolge, in der sie gefragt wuerden. */
  readonly members: readonly { readonly providerId: string; readonly state: string }[];
  /** Anbieter, die tatsaechlich liefern duerften. */
  readonly ready: readonly string[];
  readonly note: string;
}

export interface DiagnosticsReport {
  readonly generatedAt: Date;
  readonly providers: readonly ProviderDiagnostic[];
  readonly chains: readonly ChainDiagnostic[];
  /** Kurzfassung fuer den ersten Blick. */
  readonly headline: string;
  readonly anyProductionVerified: boolean;
}

const HOUR_MS = 3_600_000;

export async function loadDiagnostics(input: {
  readonly db: Database;
  readonly now: Date;
}): Promise<DiagnosticsReport> {
  const since = new Date(input.now.getTime() - HOUR_MS);

  const statuses = await input.db
    .select()
    .from(providerCapabilityStatus)
    .orderBy(providerCapabilityStatus.providerId, providerCapabilityStatus.capability);

  const providers: ProviderDiagnostic[] = [];

  for (const status of statuses) {
    const [lastSuccess] = await input.db
      .select({ at: providerRequests.at, latencyMs: providerRequests.latencyMs })
      .from(providerRequests)
      .where(
        sql`${providerRequests.providerId} = ${status.providerId}
            and ${providerRequests.capability} = ${status.capability}
            and ${providerRequests.success}`,
      )
      .orderBy(desc(providerRequests.at))
      .limit(1);

    const [lastFailure] = await input.db
      .select({
        at: providerRequests.at,
        failureClass: providerRequests.failureClass,
        failureReason: providerRequests.failureReason,
      })
      .from(providerRequests)
      .where(
        sql`${providerRequests.providerId} = ${status.providerId}
            and ${providerRequests.capability} = ${status.capability}
            and not ${providerRequests.success}`,
      )
      .orderBy(desc(providerRequests.at))
      .limit(1);

    const [window] = await input.db
      .select({
        count: sql<number>`count(*)::int`,
        errors: sql<number>`(count(*) filter (where not ${providerRequests.success}))::int`,
        schemaValid: sql<boolean | null>`bool_and(${providerRequests.schemaValid})`,
      })
      .from(providerRequests)
      .where(
        sql`${providerRequests.providerId} = ${status.providerId}
            and ${providerRequests.capability} = ${status.capability}
            and ${providerRequests.at} >= ${since}`,
      );

    const count = window?.count ?? 0;
    providers.push({
      providerId: status.providerId,
      capability: status.capability,
      state: status.state,
      implementationConfidence: status.implementationConfidence,
      productionVerified: status.productionVerified,
      schemaValidated: window?.schemaValid ?? null,
      lastSmokeTestAt: status.lastSmokeTestAt,
      lastSmokeTestStatus: status.lastSmokeTestStatus,
      lastSmokeTestDetail: status.lastSmokeTestDetail,
      lastSuccessAt: lastSuccess?.at ?? null,
      lastSuccessLatencyMs: lastSuccess?.latencyMs ?? null,
      lastFailureAt: lastFailure?.at ?? null,
      lastFailureClass: lastFailure?.failureClass ?? null,
      lastFailureReason: lastFailure?.failureReason ?? null,
      requestsLastHour: count,
      // Ausdruecklich `null` statt 0, wenn nichts lief: eine Fehlerquote von 0
      // ohne Anfragen waere eine Aussage ueber nichts.
      errorRateLastHour: count === 0 ? null : (window?.errors ?? 0) / count,
    });
  }

  const capabilities = [...new Set(statuses.map((s) => s.capability))];
  const chains: ChainDiagnostic[] = capabilities.map((capability) => {
    const members = providers
      .filter((p) => p.capability === capability)
      .map((p) => ({ providerId: p.providerId, state: p.state }));
    const ready = providers
      .filter(
        (p) =>
          p.capability === capability &&
          p.productionVerified &&
          (p.state === "CAPABILITY_READY" || p.state === "PRODUCTION_ENABLED"),
      )
      .map((p) => p.providerId);

    return {
      capability,
      members,
      ready,
      note:
        ready.length > 0
          ? `${String(ready.length)} von ${String(members.length)} Anbietern einsatzbereit.`
          : members.some((m) => m.state === "BLOCKED")
            ? "Kein Anbieter einsatzbereit: mindestens einer ist gesperrt. Eine Sperre loest sich nicht von selbst."
            : "Kein Anbieter einsatzbereit.",
    };
  });

  const anyProductionVerified = providers.some((p) => p.productionVerified);

  return {
    generatedAt: input.now,
    providers,
    chains,
    anyProductionVerified,
    headline: anyProductionVerified
      ? "PROVIDER VERIFIED"
      : providers.length === 0
        ? "NO PROVIDER CONFIGURED"
        : providers.some((p) => p.state === "BLOCKED")
          ? "BLOCKED"
          : "WAITING FOR PROVIDER",
  };
}

/**
 * Der zuletzt gemessene Zustand aus dem Provider-Health-Takt.
 *
 * Getrennt vom Reifegrad: der Takt misst laufend, der Reifegrad aendert sich
 * nur bei einem Smoke-Test. Beides zusammen beantwortet „laeuft es gerade"
 * und „darf es ueberhaupt".
 */
export async function loadLatestHealthSamples(
  db: Database,
): Promise<readonly (typeof providerStatusSamples.$inferSelect)[]> {
  const rows = await db
    .select()
    .from(providerStatusSamples)
    .orderBy(providerStatusSamples.providerId, desc(providerStatusSamples.observedAt));

  const seen = new Set<string>();
  const out: (typeof providerStatusSamples.$inferSelect)[] = [];
  for (const row of rows) {
    if (seen.has(row.providerId)) continue;
    seen.add(row.providerId);
    out.push(row);
  }
  return out;
}

/** Reifegrad eines einzelnen Anbieters. Fuer gezielte Nachfragen. */
export async function loadProviderDiagnostic(
  db: Database,
  providerId: string,
): Promise<readonly (typeof providerCapabilityStatus.$inferSelect)[]> {
  return db
    .select()
    .from(providerCapabilityStatus)
    .where(eq(providerCapabilityStatus.providerId, providerId));
}
