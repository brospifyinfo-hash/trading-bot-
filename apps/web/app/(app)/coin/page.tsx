import { explainCoin, loadEntryScore, type CoinCheck, type CoinExplanation } from "@sae/db";

import { adresseAusEingabe } from "@/lib/address";
import { CoinLookup } from "@/components/CoinLookup";
import { CopyButton } from "@/components/CopyButton";
import { db } from "@/lib/db";
import { checkWebEnv, classifyDatabaseFailure } from "@/lib/readiness";

/**
 * „Warum hat er DIESEN Coin nicht gekauft?"
 *
 * Diese Frage kam zweimal, und beide Male war die beste Antwort eine
 * Vermutung aus Logzeilen. Vermutungen sind in diesem Projekt teuer bezahlt
 * worden: §144 (die Schwelle entschied nichts, weil davor ein Tor zu war),
 * §149 (der Groessendeckel stand offen) und §150 (der Suchraum war leer)
 * waren alle drei Lagen, in denen ein RICHTIG rechnender Bot wie ein kaputter
 * aussah. Diese Seite ist das Werkzeug, das diese Verwechslung beendet.
 *
 * Sie ist ausdruecklich LESEND und braucht keine Anmeldung: sie aendert
 * nichts, und eine Diagnose, die man erst freischalten muss, wird nicht
 * benutzt.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const VERDICT_TEXT: Readonly<Record<string, string>> = {
  OK: "offen",
  BLOCKIERT: "ZU",
  UNBEKANNT: "unbekannt",
};

function zeit(d: Date | null): string {
  return d === null ? "—" : d.toISOString();
}

function Checks({ checks }: { readonly checks: readonly CoinCheck[] }) {
  return (
    <div className="paper-table">
      <table>
        <thead>
          <tr>
            <th>Tor</th>
            <th>Urteil</th>
            <th>Befund</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c, i) => (
            <tr key={`${c.tor}-${String(i)}`} data-verdict={c.verdict}>
              <td className="paper-mint">{c.tor}</td>
              <td className="status">{VERDICT_TEXT[c.verdict] ?? c.verdict}</td>
              <td>{c.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Antwort({
  e,
  adresse,
  schwelle,
}: {
  readonly e: CoinExplanation;
  /** Die aus der Eingabe gelesene Adresse — nicht die rohe Eingabe. */
  readonly adresse: string;
  readonly schwelle: {
    readonly score: number;
    readonly mode: string;
    readonly maxMarketCapUsd: bigint;
    readonly maxCoinAgeMinutes: number | null;
  };
}) {
  const zu = e.checks.filter((c) => c.verdict === "BLOCKIERT");
  const offen = e.checks.filter((c) => c.verdict === "UNBEKANNT");

  return (
    <>
      <section className="headline" data-connected={zu.length === 0}>
        <h1>
          {!e.bekannt
            ? "NICHT IN DER DATENBANK"
            : zu.length === 0
              ? "KEIN TOR IST ZU"
              : `GESTOPPT: ${zu.map((c) => c.tor).join(" · ")}`}
        </h1>
        <p>
          {!e.bekannt
            ? "Diese Adresse ist dem System nie begegnet. Das ist eine Aussage über die " +
              "Datenquellen, nicht über den Coin und nicht über Ihre Einstellungen."
            : zu.length === 0
              ? "Nach dem heutigen Stand und Ihren heutigen Einstellungen würde nichts diesen " +
                "Coin aufhalten. Das heißt NICHT, dass er gekauft wird: der Score muss die " +
                "Schwelle noch erreichen, und ob er das tat, steht unten unter „Letzte " +
                "Entscheidung“."
              : zu.length === 1
                ? "Ein Tor hat gehalten. Alles, was in der Reihenfolge danach kommt, wurde " +
                  "für diesen Coin nie gerechnet — insbesondere die Schwelle."
                : "Mehrere Tore haben gehalten. Das oberste in der Liste unten ist das, das " +
                  "zuerst gegriffen hat."}
        </p>
      </section>

      <main className="workspace">
        <section className="panel">
          <h2>Der Coin</h2>
          <dl className="kv">
            <div>
              <dt>Symbol</dt>
              <dd>{e.symbol ?? "unbekannt"}</dd>
            </div>
            <div>
              <dt>Mint</dt>
              <dd>
                <span className="mint-cell">
                  <span className="paper-mint">{e.mint}</span>
                  <CopyButton value={e.mint} label="Mint" />
                </span>
              </dd>
            </div>
            <div>
              <dt>Gefunden über</dt>
              <dd>
                {e.gefundenUeber === "HANDELSPAAR"
                  ? "die Adresse des Handelspaars"
                  : e.gefundenUeber === "MINT"
                    ? "die Mint-Adresse"
                    : "gar nicht"}
              </dd>
            </div>
            <div>
              <dt>Zustand</dt>
              <dd>{e.state ?? "—"}</dd>
            </div>
            <div>
              <dt>Erstkontakt</dt>
              <dd>{zeit(e.firstSeenAt)}</dd>
            </div>
            <div>
              <dt>Pool entstand</dt>
              <dd>{zeit(e.launchedAt)}</dd>
            </div>
            <div>
              <dt>Jüngste Marktdaten</dt>
              <dd>{zeit(e.snapshotAt)}</dd>
            </div>
            <div>
              <dt>Quelle</dt>
              <dd>{e.snapshotProvider ?? "—"}</dd>
            </div>
          </dl>
          {e.gefundenUeber === "HANDELSPAAR" && (
            <p className="hint">
              Gesucht wurde mit <code>{adresse}</code> — das ist die Adresse des
              Handelspaars, nicht die des Coins. Der Coin dahinter steht oben als Mint.
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Tor für Tor</h2>
          <p>
            Die Reihenfolge ist die des Entscheidungswegs: Suchraum, dann die harten Tore,
            dann die Schwelle. Ein geschlossenes Tor macht alles danach bedeutungslos — das
            war der Fehler, der monatelang als „die Schwelle ist zu hoch“ gelesen wurde.
          </p>
          <Checks checks={e.checks} />
          {offen.length > 0 && (
            <p className="hint">
              <strong>„unbekannt“ heißt nicht „in Ordnung“:</strong> der Wert wurde nicht
              gemessen. Im offensiven Modus hält das den Bot nicht auf, im vorsichtigen schon.
              Welche der beiden Lesarten gerade gilt, steht unten bei den Einstellungen.
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Letzte Entscheidung</h2>
          {e.letzteEntscheidung === null ? (
            <p className="placeholder">
              <strong>NIE BEWERTET</strong>
              <br />
              Zu diesem Coin wurde noch keine Entscheidung festgehalten. Entweder kam er nie
              in den Suchraum, oder die Datenlage reichte nicht für eine Bewertung — in dem
              Fall entsteht keine Zeile, und eine anzulegen hieße, ein Urteil zu behaupten,
              das nie gefällt wurde.
            </p>
          ) : (
            <dl className="kv">
              <div>
                <dt>Urteil</dt>
                <dd>{e.letzteEntscheidung.kind}</dd>
              </div>
              <div>
                <dt>Score</dt>
                <dd>
                  {e.letzteEntscheidung.finalScore === null
                    ? "nicht berechenbar"
                    : `${String(e.letzteEntscheidung.finalScore)} von ${String(schwelle.score)}`}
                </dd>
              </div>
              <div>
                <dt>Datenvollständigkeit</dt>
                <dd>{`${(e.letzteEntscheidung.dataCompleteness * 100).toFixed(0)} %`}</dd>
              </div>
              <div>
                <dt>Wann</dt>
                <dd>{zeit(e.letzteEntscheidung.at)}</dd>
              </div>
            </dl>
          )}

          {e.notierteGruende !== null && (
            <>
              <h3>Was der Bot damals selbst aufgeschrieben hat</h3>
              <p className="hint">
                Vom {zeit(e.notierteGruende.at)}, Urteil {e.notierteGruende.kind}. Das ist
                das Protokoll von damals — die Tore oben sind die Rechnung von jetzt. Weichen
                die beiden ab, haben sich die Daten oder Ihre Einstellungen geändert.
              </p>
              <ul>
                {e.notierteGruende.gruende.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Wogegen gemessen wurde</h2>
          <dl className="kv">
            <div>
              <dt>Schwelle</dt>
              <dd>{schwelle.score}</dd>
            </div>
            <div>
              <dt>Modus</dt>
              <dd>{schwelle.mode}</dd>
            </div>
            <div>
              <dt>Max. Marktkapital</dt>
              <dd>{`${Number(schwelle.maxMarketCapUsd).toLocaleString("de-DE")} USD`}</dd>
            </div>
            <div>
              <dt>Max. Alter</dt>
              <dd>
                {schwelle.maxCoinAgeMinutes === null
                  ? "keine Grenze"
                  : `${String(schwelle.maxCoinAgeMinutes)} Minuten`}
              </dd>
            </div>
          </dl>
          <p className="hint">
            Das sind die Werte von JETZT. Diese Seite stellt die Entscheidung von damals
            nicht nach — sie rechnet den heutigen Stand gegen die heutigen Einstellungen.
            Ändern lassen sich die Werte auf dem <a href="/">Dashboard</a>.
          </p>
        </section>

        <CoinLookup wert={e.gesucht} />
      </main>
    </>
  );
}

export default async function CoinPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactNode> {
  const params = await searchParams;
  const roh = params["mint"];
  const eingabe = typeof roh === "string" ? roh : Array.isArray(roh) ? roh[0] ?? "" : "";

  if (eingabe.trim().length === 0) {
    return (
      <main className="workspace">
        <CoinLookup />
      </main>
    );
  }

  const adresse = adresseAusEingabe(eingabe);
  if (adresse === null) {
    return (
      <main className="workspace">
        <section className="panel">
          <h2>Das ist keine Adresse</h2>
          <p className="placeholder">
            <strong>EINGABE UNBRAUCHBAR</strong>
            <br />
            Eine Solana-Adresse besteht aus 32 bis 44 Base58-Zeichen. Die Eingabe erfüllt
            das nicht — deshalb wurde gar nicht gesucht. Hätte sie als Suchbegriff an die
            Datenbank gegangen, hätte die Antwort „nicht gefunden“ gelautet, und das wäre
            eine Aussage über den Coin gewesen statt über den Tippfehler.
          </p>
          <CoinLookup wert={eingabe} />
        </section>
      </main>
    );
  }

  const readiness = checkWebEnv();
  if (readiness.kind !== "READY") {
    return (
      <main className="workspace">
        <section className="panel">
          <h2>Noch keine Auskunft möglich</h2>
          <p className="placeholder">
            <strong>NICHT KONFIGURIERT</strong>
            <br />
            Dieser Instanz fehlt Konfiguration; ohne Datenbank gibt es nichts nachzusehen.
            Was genau fehlt, steht auf dem <a href="/">Dashboard</a>.
          </p>
        </section>
      </main>
    );
  }

  let erklaerung: CoinExplanation;
  let schwelle: Awaited<ReturnType<typeof loadEntryScore>>;
  try {
    schwelle = await loadEntryScore(db());
    erklaerung = await explainCoin(db(), adresse, new Date(), {
      maxMarketCapUsd: schwelle.maxMarketCapUsd,
      maxCoinAgeMinutes: schwelle.maxCoinAgeMinutes,
      minFinalScore: schwelle.score,
      mode: schwelle.mode,
    });
  } catch (error: unknown) {
    // Der Fehler wird klassifiziert, nie ausgegeben: eine Postgres-Meldung
    // enthaelt die Verbindungszeichenfolge samt Passwort.
    const art = classifyDatabaseFailure(error);
    return (
      <main className="workspace">
        <section className="panel">
          <h2>Keine Auskunft möglich</h2>
          <p className="placeholder">
            <strong>{art === "SCHEMA_MISSING" ? "MIGRATIONEN FEHLEN" : "DATENBANK NICHT ERREICHBAR"}</strong>
            <br />
            Die Abfrage ist fehlgeschlagen. Näheres auf dem <a href="/">Dashboard</a>.
          </p>
        </section>
      </main>
    );
  }

  // Die gesuchte Eingabe gehoert in die Antwort, nicht die bereinigte Adresse:
  // sonst sieht der Betreiber nicht, dass ein Paar-Link aufgeloest wurde.
  return (
    <Antwort
      e={{ ...erklaerung, gesucht: eingabe.trim() }}
      adresse={adresse}
      schwelle={schwelle}
    />
  );
}
