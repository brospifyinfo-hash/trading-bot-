import { createDatabase, loadDashboardState, type Panel } from "@sae/db";
import { loadEnv, webEnvSchema } from "@sae/config";

import { BotStatusBar } from "@/components/BotStatusBar";

/**
 * Dashboard.
 *
 * Liest echte Daten aus derselben Datenbank, in die die Worker schreiben. Es
 * gibt keine Beispielwerte und keine Platzhalterzahlen: was hier steht, steht
 * so auch in der Datenbank — oder es steht ein Leerzustand mit dem Grund.
 *
 * Der Grund fuer diese Strenge ist nicht Purismus. Eine Oberflaeche, die
 * erfundene Kennzahlen zeigt, gewoehnt einen daran, ihnen zu glauben — und
 * genau dann, wenn spaeter echte Zahlen kommen, sieht niemand mehr den
 * Unterschied.
 */

export const dynamic = "force-dynamic";

function PanelBody<T>({
  panel,
  render,
}: {
  readonly panel: Panel<T>;
  readonly render: (value: T) => React.ReactNode;
}): React.ReactNode {
  if (panel.kind === "DATA") return render(panel.value);
  if (panel.kind === "INSUFFICIENT") {
    return (
      <p className="placeholder">
        <strong>INSUFFICIENT DATA</strong>
        <br />
        {panel.have} von {panel.need} — {panel.reason}
      </p>
    );
  }
  return (
    <p className="placeholder">
      <strong>WAITING</strong>
      <br />
      {panel.reason}
    </p>
  );
}

const STATUS_LABEL: Record<string, string> = {
  CONNECTED: "CONNECTED",
  DEGRADED: "DEGRADED",
  BLOCKED: "BLOCKED",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_CONFIGURED: "NOT CONFIGURED",
};

export default async function DashboardPage(): Promise<React.ReactNode> {
  const env = loadEnv(webEnvSchema, process.env);
  const db = createDatabase(env.DATABASE_URL, { readonly: true });
  const state = await loadDashboardState({ db, now: new Date() });

  return (
    <>
      <BotStatusBar />

      <section className="headline" data-connected={state.marketDataConnected}>
        <h1>{state.headline}</h1>
        {!state.marketDataConnected && (
          <p>
            Ohne erreichbare Marktdatenquelle gibt es keine Trefferquote, keinen
            Erwartungswert und keine Strategieleistung — nicht weil sie schlecht waeren,
            sondern weil sie nicht gemessen sind.
          </p>
        )}
      </section>

      <main className="workspace">
        <section className="panel">
          <h2>Datenquellen</h2>
          {state.providers.length === 0 ? (
            <p className="placeholder">
              <strong>NOT CONFIGURED</strong>
              <br />
              Keine Quelle hinterlegt. Bis dahin laeuft nur die Provider-Pruefung.
            </p>
          ) : (
            <table className="providers">
              <thead>
                <tr>
                  <th>Quelle</th>
                  <th>Status</th>
                  <th>Latenz p95</th>
                  <th>Frische</th>
                  <th>Rate Limit</th>
                  <th>Letzter Erfolg</th>
                </tr>
              </thead>
              <tbody>
                {state.providers.map((p) => (
                  <tr key={p.providerId} data-status={p.status}>
                    <td>
                      {p.providerId}
                      <span className="caps">{p.capabilities.join(", ")}</span>
                    </td>
                    <td className="status">{STATUS_LABEL[p.status] ?? p.status}</td>
                    <td>{p.latencyMsP95 === null ? "—" : `${p.latencyMsP95.toFixed(0)} ms`}</td>
                    <td>
                      {p.dataFreshnessSeconds === null
                        ? "—"
                        : `${p.dataFreshnessSeconds.toFixed(0)} s`}
                    </td>
                    <td>
                      {p.rateLimitRemaining === null || p.rateLimitLimit === null
                        ? "—"
                        : `${p.rateLimitRemaining}/${p.rateLimitLimit}`}
                    </td>
                    <td>{p.lastSuccessAt === null ? "nie" : p.lastSuccessAt.toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {state.providers.some((p) => p.lastFailureReason !== null) && (
            <ul className="failures">
              {state.providers
                .filter((p) => p.lastFailureReason !== null)
                .map((p) => (
                  <li key={p.providerId}>
                    <b>{p.providerId}</b>: {p.lastFailureReason}
                  </li>
                ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Aufnahme</h2>
          <PanelBody
            panel={state.ingestion}
            render={(v) => (
              <dl className="kv">
                <div>
                  <dt>Snapshots</dt>
                  <dd>{v.snapshotCount}</dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>{v.distinctTokens}</dd>
                </div>
                <div>
                  <dt>Zuletzt</dt>
                  <dd>{v.lastSnapshotAt?.toISOString() ?? "—"}</dd>
                </div>
                <div>
                  <dt>Nach Qualitaet</dt>
                  <dd>
                    {Object.entries(v.byTier)
                      .map(([tier, n]) => `${tier}: ${n}`)
                      .join(" · ")}
                  </dd>
                </div>
              </dl>
            )}
          />
        </section>

        <section className="panel">
          <h2>Gelegenheiten</h2>
          <PanelBody
            panel={state.opportunities}
            render={(v) => (
              <dl className="kv">
                {Object.entries(v.byState).map(([stateName, count]) => (
                  <div key={stateName}>
                    <dt>{stateName}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            )}
          />
        </section>

        <section className="panel">
          <h2>Paper Trading</h2>
          <PanelBody
            panel={state.paper}
            render={(rows) => (
              <table className="providers">
                <thead>
                  <tr>
                    <th>Strom</th>
                    <th>Sizing</th>
                    <th>offen</th>
                    <th>geschlossen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.stream}-${r.sizingMode}`}>
                      <td>{r.stream}</td>
                      <td>{r.sizingMode}</td>
                      <td>{r.openPositions}</td>
                      <td>{r.closedPositions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          />
        </section>

        <section className="panel">
          <h2>Research</h2>
          <PanelBody
            panel={state.research}
            render={(v) => (
              <>
                <dl className="kv">
                  {Object.entries(v.candidatesByState).map(([stateName, count]) => (
                    <div key={stateName}>
                      <dt>{stateName}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
                <p className="placeholder">
                  {v.promotedCount === 0
                    ? "NO EDGE VALIDATED — kein Kandidat hat alle Gates bestanden."
                    : `${v.promotedCount} Kandidat(en) vorlegbar. Freigabe erfolgt von Hand.`}
                </p>
              </>
            )}
          />
        </section>

        {state.testData !== null && (
          <section className="panel test-data">
            <h2>TEST / DEVELOPMENT DATA</h2>
            <p className="placeholder">{state.testData.note}</p>
            <dl className="kv">
              {Object.entries(state.testData.opportunities.byState).map(([name, count]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{count}</dd>
                </div>
              ))}
              {state.testData.paper.map((r) => (
                <div key={`${r.stream}-${r.sizingMode}`}>
                  <dt>
                    {r.stream} · {r.sizingMode}
                  </dt>
                  <dd>
                    {r.openPositions} offen / {r.closedPositions} zu
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="panel">
          <h2>Strategie</h2>
          <p className="placeholder">
            <strong>NO EDGE VALIDATED</strong>
            <br />
            Live-Handel bleibt aus, solange kein Kandidat alle zehn Promotionsgates
            bestanden hat. Das Gate fuer das Kostenmodell steht ohne erreichbare Quelle
            ausdruecklich auf FAIL.
          </p>
        </section>
      </main>
    </>
  );
}
