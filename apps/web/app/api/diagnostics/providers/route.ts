import { loadDiagnostics, loadLatestHealthSamples } from "@sae/db";

import { db } from "@/lib/db";

/**
 * Diagnose-Endpunkt fuer Anbieter.
 *
 * Beantwortet nach einem Deployment ohne Kenntnis des Codes: kommt dieses
 * System an Daten, und wenn nein, woran haengt es?
 *
 * Was hier bewusst NICHT erscheint: Verbindungszeichenfolgen, API-Schluessel,
 * Anbieter-Rohantworten. Ein Diagnose-Endpunkt ist kein Nebeneingang in die
 * Konfiguration.
 *
 * Der Statuscode traegt die Aussage mit: 200, sobald ein Anbieter verifiziert
 * ist, sonst 503. Damit kann eine Ueberwachung ihn ohne Textanalyse pruefen.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const now = new Date();
    const report = await loadDiagnostics({ db: db(), now });
    const health = await loadLatestHealthSamples(db());

    return Response.json(
      {
        ...report,
        healthSamples: health.map((h) => ({
          providerId: h.providerId,
          status: h.status,
          observedAt: h.observedAt,
          lastSuccessAt: h.lastSuccessAt,
          lastFailureAt: h.lastFailureAt,
          lastFailureReason: h.lastFailureReason,
          latencyMsP95: h.latencyMsP95,
          dataFreshnessSeconds: h.dataFreshnessSeconds,
        })),
      },
      { status: report.anyProductionVerified ? 200 : 503 },
    );
  } catch {
    // Die Fehlermeldung kann eine Verbindungszeichenfolge enthalten. Sie wird
    // deshalb bewusst nicht gebunden und nicht ausgegeben — der Aufrufer
    // bekommt die Tatsache, nicht das Detail.
    return Response.json(
      { headline: "DIAGNOSTICS_UNAVAILABLE", detail: "Datenbank nicht erreichbar." },
      { status: 500 },
    );
  }
}
