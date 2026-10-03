import type { DecisionRunReport } from "@sae/db";

/**
 * Wo die bekannten Coins bleiben.
 *
 * Der Suchraum entscheidet, welche Coins ueberhaupt bewertet werden. Darueber
 * sagte bis hierher eine einzige Zahl etwas — `beobachtet`. Steht die auf 0,
 * ist das bei gesetzter Altersgrenze eine wahrscheinliche Lage und sieht
 * genauso aus wie ein kaputter Bot. Dasselbe Muster wie §140, §144 und §145;
 * es soll sich nicht zum vierten Mal wiederholen.
 */
const TEXT: Readonly<Record<string, string>> = {
  OK: "im Suchraum — werden bewertet",
  GESPERRT: "gesperrt oder abgelehnt",
  KEINE_AKTUELLEN_DATEN: "keine Marktdaten der letzten sechs Stunden",
  KEIN_PREIS: "kein Preis gemeldet",
  ZU_WENIG_LIQUIDITAET: "Liquidität unter 5.000 USD",
  KEIN_VOLUMEN: "kein 24h-Volumen gemeldet",
  KEINE_MARKTKAPITALISIERUNG: "keine Marktkapitalisierung gemeldet",
  ZU_GROSS: "über Ihrer Größengrenze",
  ALTER_UNBEKANNT: "Entstehungszeit des Pools unbekannt",
  ZU_ALT: "älter als Ihre Altersgrenze",
};

export function Universe({ run }: { readonly run: DecisionRunReport | null }) {
  const zahlen = run?.universe ?? null;

  if (zahlen === null || Object.keys(zahlen).length === 0) {
    return (
      <section className="panel">
        <h2>Suchraum</h2>
        <p className="placeholder">
          <strong>NOCH NICHT AUFGEZEICHNET</strong>
          <br />
          Der Worker hat die Aufschlüsselung in diesem Lauf nicht mitgeschrieben. Sie
          erscheint ab dem nächsten abgeschlossenen Bewertungslauf.
        </p>
      </section>
    );
  }

  const zeilen = Object.entries(zahlen).sort(([a, x], [b, y]) =>
    a === "OK" ? -1 : b === "OK" ? 1 : y - x || a.localeCompare(b),
  );
  const gesamt = zeilen.reduce((n, [, anzahl]) => n + anzahl, 0);
  const ok = zahlen["OK"] ?? 0;
  const alterUnbekannt = zahlen["ALTER_UNBEKANNT"] ?? 0;

  return (
    <section className="panel">
      <h2>Suchraum</h2>
      <p>
        Von <strong>{gesamt.toLocaleString("de-DE")}</strong> bekannten Coins werden{" "}
        <strong>{ok.toLocaleString("de-DE")}</strong> bewertet. Wo die übrigen bleiben, steht
        hier — Stand des letzten Bewertungslaufs.
      </p>

      {ok === 0 && (
        <p className="placeholder" role="status">
          <strong>KEIN COIN IM SUCHRAUM</strong>
          <br />
          In dieser Lage kann der Bot nichts kaufen, und zwar nicht weil er defekt ist,
          sondern weil kein Coin die Filter passiert. Der häufigste Grund steht unten ganz
          oben.
        </p>
      )}

      <div className="paper-table">
        <table>
          <thead>
            <tr>
              <th>Anzahl</th>
              <th>Grund</th>
              <th>Kennung</th>
            </tr>
          </thead>
          <tbody>
            {zeilen.map(([grund, anzahl]) => (
              <tr key={grund} data-ok={grund === "OK" ? "true" : undefined}>
                <td>
                  <strong>{anzahl.toLocaleString("de-DE")}</strong>
                </td>
                <td>{TEXT[grund] ?? "unbekannter Grund"}</td>
                <td className="paper-mint">{grund}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {alterUnbekannt > 0 && (
        <p className="hint">
          <strong>Zu „Entstehungszeit unbekannt":</strong> die Pool-Entstehungszeit wird nur
          beim ersten Durchlauf eines Coins gespeichert, und nur wenn der Anbieter sie
          mitgeliefert hat. Fehlt sie, bleibt sie leer — und bei gesetzter Altersgrenze fällt
          der Coin dauerhaft heraus. Ist diese Zahl groß und Sie wollen die Altersgrenze
          behalten, muss die Entstehungszeit nachgetragen werden; bis dahin hilft es, die
          Altersgrenze zu leeren.
        </p>
      )}

      <p className="hint">
        Die Zahlen beschreiben die Coins, die dieses System KENNT. Sie sagen nichts darüber,
        wie viele es auf Solana gibt — die Suche deckt ihre angebundenen Quellen ab, nicht den
        Markt.
      </p>
    </section>
  );
}
