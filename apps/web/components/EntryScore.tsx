import type { DecisionRunReport } from "@sae/db";

/**
 * Die eine Zahl, die der Betreiber frei waehlt.
 *
 * Zwei Entscheidungen stecken in dieser Datei, und beide sind der Grund, warum
 * sie so aussieht, wie sie aussieht.
 *
 * **Sie zeigt an und nimmt nicht entgegen.** Diese Oberflaeche hat keine
 * Anmeldung. Ein Eingabefeld, das die Handelsschwelle schreibt, waere ein
 * Schreibzugriff fuer jeden, der die Adresse kennt. Solange die Anmeldung nicht
 * steht, wird die Schwelle dort gesetzt, wo ohnehin nur der Betreiber
 * hinkommt — in der Umgebung des Workers.
 *
 * **Sie zeigt, was der WORKER benutzt hat, nicht was hier in der Umgebung
 * steht.** Das Dashboard laeuft bei Vercel, der Worker bei Railway; zwei
 * getrennte Umgebungen. Laese diese Anzeige `process.env`, stuende hier eine
 * Zahl, mit der nie jemand entschieden hat — die gefaehrlichste Sorte Anzeige,
 * weil sie plausibel aussieht. Also kommt die Zahl aus dem letzten
 * Entscheidungslauf.
 */
export function EntryScore({
  run,
  variable,
  min,
  max,
}: {
  readonly run: DecisionRunReport | null;
  readonly variable: string;
  readonly min: number;
  readonly max: number;
}) {
  const beispiele = [10, 35, 50, 70].filter((n) => n >= min && n <= max);
  const schwelle = run?.entryThreshold ?? null;
  const herkunft = run?.entryThresholdSource ?? null;

  return (
    <section className="panel">
      <h2>Einstiegsschwelle</h2>

      {schwelle === null ? (
        <p className="placeholder">
          <strong>NOCH NICHT GEMELDET</strong>
          <br />
          Der Worker hat noch keinen Bewertungslauf abgeschlossen. Bis dahin ist nicht
          belegt, mit welcher Schwelle er rechnet — und eine Zahl zu zeigen, die nur
          hier in der Oberflaeche steht, waere geraten.
        </p>
      ) : (
        <>
          <p className="bigNumber">
            <span className="bigNumber__value">{schwelle}</span>
            <span className="bigNumber__unit">von 100 Punkten</span>
          </p>
          <p>
            {herkunft === "SET"
              ? "Von Ihnen gesetzt."
              : herkunft === "DEFAULT"
                ? "Ausgelieferte Voreinstellung — nicht gesetzt."
                : "Herkunft in diesem Lauf nicht aufgezeichnet."}{" "}
            Gemeldet vom letzten abgeschlossenen Bewertungslauf des Workers, nicht aus
            der Umgebung dieser Oberflaeche.
          </p>
          <p>
            Ein Coin wird gekauft, sobald seine Gesamtbewertung diesen Wert erreicht
            und alle uebrigen Tore offen sind. Niedriger heisst mehr Einstiege und
            schlechtere Durchschnittsqualitaet, hoeher heisst seltener und waehlerischer.
          </p>
        </>
      )}

      <h3>Aendern</h3>
      <p>
        Railway, Projekt <code>honest-adaptation</code>, Umgebung <code>production</code>,
        Dienst <code>consumer</code> → <em>Variables</em>. Variable <code>{variable}</code>{" "}
        auf eine ganze Zahl zwischen {min} und {max} setzen. Der Dienst startet daraufhin
        neu und rechnet ab dem naechsten Lauf mit dem neuen Wert; diese Anzeige folgt,
        sobald der Lauf durch ist.
      </p>
      <p className="hint">Gaengige Werte: {beispiele.join(" · ")}. Jede Zahl dazwischen geht genauso.</p>
      <p className="hint">
        Steht dort etwas, das keine Zahl zwischen {min} und {max} ist, entscheidet der Bot
        gar nicht und nennt den Grund. Das ist Absicht: bei einer stillen Ruecknahme auf
        die Voreinstellung wuerde bei einer anderen Zahl gehandelt als der gesetzten.
      </p>
      <p className="hint">
        Die Buchfuehrung bleibt dieselbe: Barbestand, offene Positionen und Verlustgrenzen
        laufen ueber die Schwellenaenderung hinweg weiter. Nur die Regel, nach der neu
        entschieden wird, aendert sich — und jede Entscheidung bleibt der Schwelle
        zugeordnet, unter der sie gefallen ist.
      </p>
    </section>
  );
}
