import { providerId, systemClock } from "@sae/core";
import { loadEnv, providerEnvSchema, readProviderConfig } from "@sae/config";
import { summarizeFleet, type ProviderStatusReport } from "@sae/providers";
import { createDatabase, ProviderHealthStore } from "@sae/db";

import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: provider-health.
 *
 * Der einzige Takt, der auch ohne Marktdaten laeuft — und damit der
 * Mechanismus, mit dem das System von selbst wieder anlaeuft. Er beantwortet
 * genau eine Frage: **gibt es eine erreichbare Quelle?**
 *
 * Zwei Dinge, die dieser Worker ausdruecklich NICHT tut:
 *
 * - Einen Anbieter abfragen, fuer den es kein gegen seine Spezifikation
 *   geprueftes Adapter-Modul gibt. Ein erfundener Pfad wuerde einen Fehlschlag
 *   erzeugen, der wie ein Anbieterproblem aussieht.
 * - Einen Erfolg behaupten, den es nicht gab. Ohne Abfrage bleiben letzter
 *   Erfolg, Latenz und Frische `null` — und ausdruecklich nicht 0.
 *
 * Das Ergebnis wird PERSISTIERT. Worker und Dashboard reden nicht miteinander;
 * ein Status im Speicher des Workers ist fuer die Anzeige nicht da.
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

/** Ein Messdurchlauf: Zustand ermitteln und festschreiben. */
export async function sampleProviderHealth(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly store: ProviderHealthStore;
  readonly at?: Date;
}): Promise<{ readonly written: number; readonly marketDataConnected: boolean; readonly summary: string }> {
  const reports = buildStatusReports(input.env);
  const fleet = summarizeFleet(reports);
  const written = await input.store.record(reports, input.at ?? systemClock.now());
  return { written, marketDataConnected: fleet.anyMarketDataConnected, summary: fleet.summary };
}

/**
 * Wie oft gemessen wird.
 *
 * Eine Minute ist ein Kompromiss: haeufig genug, dass eine wiederkehrende
 * Quelle nicht lange unbemerkt bleibt, selten genug, dass der Verlauf nicht
 * ins Unermessliche waechst. Der Wert ist eine Festlegung, keine Messung — mit
 * echten Anbietern gehoert er ueberprueft.
 */
const SAMPLE_INTERVAL_MS = 60_000;

let sampleTimer: ReturnType<typeof setInterval> | null = null;

export const providerHealthRole: RoleHandler = {
  name: "provider-health",
  async start(ctx: RoleContext): Promise<void> {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url.length === 0) {
      // Eine Messung, die nur im Log steht, beantwortet die Frage des
      // Dashboards nicht. Ohne Datenbank hat dieser Takt keinen Zweck.
      throw new Error("provider-health benoetigt DATABASE_URL");
    }
    const store = new ProviderHealthStore(createDatabase(url));

    const runOnce = async (): Promise<void> => {
      const result = await sampleProviderHealth({ env: process.env, store });
      ctx.logger.info(
        {
          role: "provider-health",
          written: result.written,
          marketDataConnected: result.marketDataConnected,
          summary: result.summary,
        },
        "Provider-Status gemessen",
      );
    };

    // Sofort einmal messen, damit der Scheduler nicht bis zum ersten Takt
    // wartet, um zu erfahren, ob es Daten gibt.
    await runOnce();
    sampleTimer = setInterval(() => {
      void runOnce().catch((error: unknown) => {
        ctx.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Provider-Messung fehlgeschlagen",
        );
      });
    }, SAMPLE_INTERVAL_MS);
  },
  async stop(): Promise<void> {
    if (sampleTimer !== null) clearInterval(sampleTimer);
    sampleTimer = null;
  },
};
