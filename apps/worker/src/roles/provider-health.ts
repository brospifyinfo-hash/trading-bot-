
import { providerId } from "@sae/core";
import { loadEnv, providerEnvSchema, readProviderConfig } from "@sae/config";
import { summarizeFleet, type ProviderStatusReport } from "@sae/providers";

import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: provider-health.
 *
 * Der einzige Takt, der auch ohne Marktdaten laeuft — und damit der
 * Mechanismus, mit dem das System von selbst wieder anlaeuft. Er beantwortet
 * genau eine Frage: **gibt es eine erreichbare Quelle?**
 *
 * Solange keine da ist, entsteht hier ein Bericht mit `NOT_CONFIGURED` oder
 * `BLOCKED` je Anbieter. Das ist kein Platzhalter, sondern das richtige
 * Ergebnis: ein Anbieter ohne Basis-URL ist nicht ausgefallen, es gibt ihn
 * hier schlicht nicht.
 *
 * Was dieser Worker NICHT tut: einen Anbieter abfragen, fuer den es keinen
 * gegen seine Spezifikation geprueften Adapter gibt. Ein erfundener Pfad
 * wuerde einen Fehlschlag erzeugen, der wie ein Anbieterproblem aussieht.
 */
export function buildStatusReports(env: NodeJS.ProcessEnv): readonly ProviderStatusReport[] {
  const providerEnv = loadEnv(providerEnvSchema, env);
  const entries = readProviderConfig(providerEnv);

  return entries.map((entry): ProviderStatusReport => {
    const status = !entry.configured
      ? "NOT_CONFIGURED"
      : entry.adapterImplemented
        ? "UNAVAILABLE"
        : "NOT_CONFIGURED";

    const detail = !entry.configured
      ? entry.requiresApiKey && !entry.apiKeyPresent
        ? "Basis-URL oder Zugangsschluessel fehlt."
        : "Keine Basis-URL hinterlegt."
      : entry.adapterImplemented
        ? "Konfiguriert, aber noch nicht abgefragt."
        : "Konfiguriert, aber kein geprueftes Adapter-Modul vorhanden.";

    return {
      providerId: providerId(entry.id),
      kind: entry.kind,
      status,
      capabilities: entry.capabilities as ProviderStatusReport["capabilities"],
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      latencyMsP50: null,
      latencyMsP95: null,
      rateLimit: null,
      dataFreshnessSeconds: null,
      detail,
    };
  });
}

export const providerHealthRole: RoleHandler = {
  name: "provider-health",
  async start(ctx: RoleContext): Promise<void> {
    const reports = buildStatusReports(process.env);
    const fleet = summarizeFleet(reports);

    ctx.logger.info(
      {
        role: "provider-health",
        marketDataConnected: fleet.anyMarketDataConnected,
        blocked: fleet.blockedCount,
        notConfigured: fleet.notConfiguredCount,
        summary: fleet.summary,
      },
      "Provider-Status ermittelt",
    );
  },
  async stop(): Promise<void> {
    // Zustandslos: der Bericht wird bei jedem Takt neu gebildet.
  },
};
