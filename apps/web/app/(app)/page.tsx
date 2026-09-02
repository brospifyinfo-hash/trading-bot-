import { loadDashboardState, type Panel } from "@sae/db";

import { db } from "@/lib/db";
import { checkWebEnv, classifyDatabaseFailure, type WebReadiness } from "@/lib/readiness";

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

/** Obergrenze der Laufzeit in Sekunden — die Seite liest die Datenbank. */
export const maxDuration = 15;

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

/**
 * Was angezeigt wird, wenn die Instanz nicht lesen kann.
 *
 * Ausdruecklich NICHT „WAITING FOR LIVE MARKET DATA": dieser Satz bedeutet, die
 * Datenbank antwortet und es fehlt nur ein Anbieter. Ihn bei ausgefallener
 * Datenbank zu zeigen waere die bequeme Luege — sie sieht nach Betrieb aus und
 * verdeckt, dass das System nicht einmal lesen kann.
 */
function NotReady({ readiness }: { readonly readiness: WebReadiness }): React.ReactNode {
  return (
    <>
      <section className="headline" data-connected={false}>
        <h1>
          {readiness.kind === "ENV_INCOMPLETE"
            ? "NICHT KONFIGURIERT"
            : readiness.kind === "SCHEMA_MISSING"
              ? "MIGRATIONEN FEHLEN"
              : "DATENBANK NICHT ERREICHBAR"}
        </h1>
        <p>
          {readiness.kind === "ENV_INCOMPLETE"
            ? "Dieser Instanz fehlt Konfiguration. Solange sie fehlt, wird nichts angezeigt — " +
              "eine Oberflaeche mit Platzhalterzahlen waere schlimmer als eine leere."
            : readiness.kind === "SCHEMA_MISSING"
              ? "Die Datenbank antwortet, aber sie ist leer: die Migrationen sind noch nicht " +
                "gefahren. Das ist kein Verbindungsproblem — es fehlt genau ein Befehl."
              : "Die Konfiguration ist vollstaendig, aber die Datenbank antwortet nicht. " +
                "Das ist kein Marktdatenproblem: ohne Datenbank ist keine Aussage moeglich."}
        </p>
      </section>

      <main className="workspace">
        <section className="panel">
          <h2>Was fehlt</h2>
          {readiness.kind === "ENV_INCOMPLETE" ? (
            <table className="providers">
              <thead>
                <tr>
                  <th>Variable</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {readiness.problems.map((p) => (
                  <tr key={p.variable} data-status="NOT_CONFIGURED">
                    <td>{p.variable}</td>
                    <td className="status">{p.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : readiness.kind === "SCHEMA_MISSING" ? (
            <p className="placeholder">
              <strong>SCHEMA LEER</strong>
              <br />
              Die Verbindung steht. Es fehlen die Tabellen. Einmal ausfuehren, gegen den
              DIREKTEN Neon-Endpunkt (Host ohne <code>-pooler</code>):
              <br />
              <code>DATABASE_URL_DIRECT=&lt;neon-direkt&gt; pnpm db:deploy</code>
              <br />
              Der Lauf ist additiv und loescht nichts; ein zweiter Lauf ist ein No-Op.
            </p>
          ) : (
            <p className="placeholder">
              <strong>KEINE VERBINDUNG</strong>
              <br />
              Die Verbindungszeichenfolge wird hier bewusst nicht angezeigt — sie enthaelt
              ein Passwort. Zu pruefen ist, ob die Datenbank laeuft und ob der eingetragene
              Endpunkt stimmt.
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Naechster Schritt</h2>
          <p className="placeholder">
            Siehe <code>docs/INFRASTRUCTURE.md</code>. Pruefen laesst sich der Zustand
            ohne diese Oberflaeche ueber <code>/api/health</code> (laeuft der Prozess)
            und <code>/api/diagnostics/providers</code> (kommt das System an Daten).
          </p>
        </section>
      </main>
    </>
  );
}

export default async function DashboardPage(): Promise<React.ReactNode> {
  // Erst die Konfiguration, dann die Datenbank. Ohne diese Reihenfolge wirft
  // `db()` beim Validieren, und ein Wurf in einer Server-Komponente wird zu
  // Next.js' Sammelmeldung „Application error" — die dem Betreiber nichts sagt.
  const readiness = checkWebEnv();
  if (readiness.kind !== "READY") return <NotReady readiness={readiness} />;

  let state: Awaited<ReturnType<typeof loadDashboardState>>;
  try {
    // Modulebene statt Request-Handler: siehe lib/db.ts.
    state = await loadDashboardState({ db: db(), now: new Date() });
  } catch (error: unknown) {
    // Der Fehler wird nur klassifiziert, nie ausgegeben: eine
    // Postgres-Fehlermeldung enthaelt die Verbindungszeichenfolge samt Passwort.
    // `classifyDatabaseFailure` liest ausschliesslich den SQLSTATE-Code.
    return <NotReady readiness={{ kind: classifyDatabaseFailure(error) }} />;
  }

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
          <h2>System</h2>
          <dl className="kv">
            <div>
              <dt>Phase</dt>
              <dd>{state.systemState.phase}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{state.systemState.workerAlive ? "aktiv" : "keine Messung"}</dd>
            </div>
            <div>
              <dt>Letzte Messung</dt>
              <dd>{state.systemState.lastProviderSampleAt?.toISOString() ?? "—"}</dd>
            </div>
            <div>
              <dt>Live-Handel</dt>
              <dd>{state.systemState.liveTradingEnabled ? "frei" : "abgeschaltet"}</dd>
            </div>
          </dl>
          {state.systemState.blockedBy.length > 0 && (
            <ul className="failures">
              {state.systemState.blockedBy.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Jobs und Queue</h2>
          <dl className="kv">
            <div>
              <dt>wartend</dt>
              <dd>{state.queue.queued}</dd>
            </div>
            <div>
              <dt>laufend</dt>
              <dd>{state.queue.running}</dd>
            </div>
            <div>
              <dt>abgeschlossen</dt>
              <dd>{state.queue.done}</dd>
            </div>
            <div>
              <dt>Dead Letter</dt>
              <dd>{state.queue.dead}</dd>
            </div>
            <div>
              <dt>in Wiederholung</dt>
              <dd>{state.queue.retryingJobs}</dd>
            </div>
            <div>
              <dt>aeltester wartend</dt>
              <dd>{state.queue.oldestQueuedAt?.toISOString() ?? "—"}</dd>
            </div>
          </dl>
          {state.recentJobs.length === 0 ? (
            <p className="placeholder">
              <strong>WAITING</strong>
              <br />
              Noch kein Auftrag eingereiht.
            </p>
          ) : (
            <table className="providers">
              <thead>
                <tr>
                  <th>Auftrag</th>
                  <th>Zustand</th>
                  <th>Versuche</th>
                  <th>Dauer</th>
                  <th>Grund</th>
                </tr>
              </thead>
              <tbody>
                {state.recentJobs.map((j) => (
                  <tr key={`${j.kind}-${j.enqueuedAt.toISOString()}`} data-status={j.state}>
                    <td>{j.kind}</td>
                    <td className="status">{j.state}</td>
                    <td>{j.attempts}</td>
                    <td>{j.durationMs === null ? "—" : `${j.durationMs} ms`}</td>
                    <td>{j.failureClass ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {state.deadLetters.length > 0 && (
          <section className="panel">
            <h2>Dead Letters</h2>
            <ul className="failures">
              {state.deadLetters.map((j) => (
                <li key={`${j.kind}-${j.enqueuedAt.toISOString()}`}>
                  <b>{j.kind}</b> nach {j.attempts} Versuchen: {j.lastError ?? "ohne Begruendung"}
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.errors.length > 0 && (
          <section className="panel">
            <h2>Fehler</h2>
            <ul className="failures">
              {state.errors.map((e) => (
                <li key={`${e.kind}-${e.at.toISOString()}`}>
                  <b>{e.kind}</b> · {e.at.toISOString()} · {e.detail}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel">
          <h2>Verpasste Gelegenheiten</h2>
          <PanelBody
            panel={state.missed}
            render={(v) => (
              <>
                <dl className="kv">
                  <div>
                    <dt>abgelaufen</dt>
                    <dd>{v.expired}</dd>
                  </div>
                  <div>
                    <dt>abgelehnt</dt>
                    <dd>{v.rejected}</dd>
                  </div>
                  <div>
                    <dt>revalidierung gescheitert</dt>
                    <dd>{v.invalidated}</dd>
                  </div>
                  <div>
                    <dt>zurueckgezogen</dt>
                    <dd>{v.cancelled}</dd>
                  </div>
                </dl>
                <p className="placeholder">
                  Zaehlungen, keine Betraege. Eine verpasste oder abgelehnte Gelegenheit
                  ist kein Verlust.
                </p>
              </>
            )}
          />
        </section>

        <section className="panel">
          <h2>Latenz</h2>
          <PanelBody
            panel={state.latency}
            render={(rows) => (
              <dl className="kv">
                {rows.map((r) => (
                  <div key={r.stream}>
                    <dt>
                      {r.stream} ({r.samples})
                    </dt>
                    <dd>
                      {r.medianObservedToDecidedMs === null
                        ? "—"
                        : `${r.medianObservedToDecidedMs.toFixed(0)} ms`}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          />
        </section>

        <section className="panel">
          <h2>Champion / Challenger</h2>
          <PanelBody
            panel={state.championChallenger}
            render={(v) => (
              <dl className="kv">
                <div>
                  <dt>Champion</dt>
                  <dd>{v.champion ?? "keiner"}</dd>
                </div>
                <div>
                  <dt>Challenger</dt>
                  <dd>{v.challengers}</dd>
                </div>
                <div>
                  <dt>vorlegbar</dt>
                  <dd>{v.promoted}</dd>
                </div>
              </dl>
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
