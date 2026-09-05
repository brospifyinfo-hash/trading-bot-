import { providerId, systemClock } from "@sae/core";
import { loadEnv, providerEnvSchema, readProviderConfig, type KnownProviderId } from "@sae/config";
import { summarizeFleet, type ProviderStatus, type ProviderStatusReport } from "@sae/providers";
import { DexScreenerMarketAdapter } from "@sae/providers";
import { createDatabase, ProviderHealthStore } from "@sae/db";

import type { RoleContext, RoleHandler } from "../role";

/**
 * Die Adresse, mit der die Erreichbarkeit geprueft wird.
 *
 * Wrapped SOL: existiert seit 2020, wird auf jedem Solana-DEX gehandelt und
 * ist damit die Adresse, bei der ein leeres Ergebnis tatsaechlich etwas ueber
 * den ANBIETER aussagt und nicht ueber den Token. Ein Memecoin waere als Sonde
 * untauglich — verschwindet er, sieht ein gesunder Anbieter krank aus.
 *
 * Diese Anfrage ist eine Lebendpruefung, keine Marktdatenerhebung: ihr
 * Ergebnis wird nicht als Snapshot gespeichert und traegt keine Entscheidung.
 */
const PROBE_MINT = "So11111111111111111111111111111111111111112";

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
/**
 * Das Ergebnis einer echten Abfrage als Zustand.
 *
 * Die Zuordnung ist die eigentliche Aussage dieses Dienstes, deshalb steht sie
 * hier ausgeschrieben und nicht als Kette von Bedingungen im Aufrufer:
 *
 * | Ergebnis            | Zustand      | Begruendung                                  |
 * |---------------------|--------------|----------------------------------------------|
 * | OK                  | CONNECTED    | geantwortet und lesbar                       |
 * | NO_DATA             | CONNECTED    | geantwortet; der Anbieter kennt den Token nur nicht |
 * | FAILED/BLOCKED      | BLOCKED      | jemand laesst uns nicht durch                |
 * | FAILED/RATE_LIMITED | DEGRADED     | erreichbar, aber gedrosselt — kommt wieder   |
 * | FAILED/sonst        | UNAVAILABLE  | keine Antwort                                |
 * | SCHEMA_REJECTED     | UNAVAILABLE  | erreichbar und unbrauchbar                   |
 *
 * Der letzte Fall ist der, bei dem man in Versuchung geraet, DEGRADED zu
 * nehmen: der Anbieter lebt ja. Aber DEGRADED laesst die Kette ihn weiter
 * fragen, und jede Antwort waere wieder unlesbar. Unbrauchbar ist naeher an
 * nicht erreichbar als an eingeschraenkt.
 */
async function probeDexScreener(baseUrl: string | undefined): Promise<{
  readonly status: ProviderStatus;
  readonly detail: string;
  readonly latencyMs: number;
  readonly ok: boolean;
}> {
  const adapter = new DexScreenerMarketAdapter({
    clock: systemClock,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  const outcome = await adapter.fetchMarkets([PROBE_MINT]);

  switch (outcome.kind) {
    case "OK":
      return {
        status: "CONNECTED",
        detail: `${String(outcome.markets.length)} Datensatz/-saetze, Schema ${adapter.schemaVersion}.`,
        latencyMs: outcome.latencyMs,
        ok: true,
      };
    case "NO_DATA":
      return {
        status: "CONNECTED",
        detail: "Geantwortet, kennt die Sondenadresse aber nicht.",
        latencyMs: outcome.latencyMs,
        ok: true,
      };
    case "SCHEMA_REJECTED":
      return {
        status: "UNAVAILABLE",
        detail: `Antwort nicht lesbar: ${outcome.reason}`,
        latencyMs: outcome.latencyMs,
        ok: false,
      };
    case "FAILED":
      return {
        status:
          outcome.failure === "BLOCKED"
            ? "BLOCKED"
            : outcome.failure === "RATE_LIMITED"
              ? "DEGRADED"
              : "UNAVAILABLE",
        detail: `${outcome.failure}: ${outcome.reason}`,
        latencyMs: outcome.latencyMs,
        ok: false,
      };
  }
}

/** Die Basis-URL, die fuer die Sonde gilt. */
function baseUrlOf(
  env: ReturnType<typeof loadEnv<typeof providerEnvSchema>>,
  id: KnownProviderId,
): string | undefined {
  return id === "dexscreener" ? env.DEXSCREENER_BASE_URL : undefined;
}

/** Anbieter, die tatsaechlich gemessen werden koennen. */
const PROBES: Partial<
  Record<KnownProviderId, (baseUrl: string | undefined) => ReturnType<typeof probeDexScreener>>
> = {
  dexscreener: probeDexScreener,
};

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
  const at = input.at ?? systemClock.now();
  const providerEnv = loadEnv(providerEnvSchema, input.env);

  // Der Konfigurationsbefund ist der Ausgangspunkt: er sagt, wer ueberhaupt
  // ansprechbar waere. Gemessen wird danach nur, wer einen geprueften Adapter
  // hat — eine Abfrage ueber einen geratenen Pfad wuerde einen Fehlschlag
  // erzeugen, der wie ein Anbieterproblem aussieht.
  const base = buildStatusReports(input.env);

  const reports = await Promise.all(
    base.map(async (report): Promise<ProviderStatusReport> => {
      const id = String(report.providerId) as KnownProviderId;
      const probe = PROBES[id];
      // NOT_CONFIGURED bleibt NOT_CONFIGURED: wer keine Basis-URL hat, wird
      // nicht gefragt, und das Ergebnis waere ohnehin nur eine Aussage ueber
      // die fehlende Konfiguration.
      if (probe === undefined || report.status === "NOT_CONFIGURED") return report;

      const result = await probe(baseUrlOf(providerEnv, id));
      return {
        ...report,
        status: result.status,
        detail: result.detail,
        // Latenz und Zeitpunkte stammen jetzt aus einer echten Anfrage. Vorher
        // waren sie null, weil nichts abgefragt wurde — und null war die
        // richtige Antwort darauf.
        latencyMsP50: result.latencyMs,
        latencyMsP95: result.latencyMs,
        lastSuccessAt: result.ok ? at : null,
        lastFailureAt: result.ok ? null : at,
        lastFailureReason: result.ok ? null : result.detail,
      };
    }),
  );

  const fleet = summarizeFleet(reports);
  const written = await input.store.record(reports, at);
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
