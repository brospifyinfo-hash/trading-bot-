import type { EntryScoreSetting } from "@sae/db";

import { EntryScoreForm } from "./EntryScoreForm";

/**
 * Die eine Zahl, die der Betreiber frei waehlt.
 *
 * Zwei Dinge, die diese Anzeige auseinanderhaelt und die vorher vermengt waren:
 *
 * **Was EINGESTELLT ist** steht in der Datenbank. Sie ist die einzige Stelle,
 * die Dashboard und Worker gemeinsam haben — die beiden laufen auf
 * verschiedenen Maschinen.
 *
 * **Was der Worker ZULETZT BENUTZT hat** steht im Entscheidungslauf. Zwischen
 * beiden liegt ein Takt. Weichen sie voneinander ab, ist die Aenderung
 * gespeichert, aber noch nicht wirksam — und genau das gehoert dann dort zu
 * lesen, statt dass jemand vor einer Zahl sitzt und sich fragt, ob sie schon
 * zaehlt.
 */
export function EntryScore({
  setting,
  benutzt,
  angemeldet,
  anmeldungEingerichtet,
  min,
  max,
}: {
  readonly setting: EntryScoreSetting;
  readonly benutzt: number | null;
  readonly angemeldet: boolean;
  readonly anmeldungEingerichtet: boolean;
  readonly min: number;
  readonly max: number;
}) {
  const wirksam = benutzt === null || benutzt === setting.score;

  return (
    <section className="panel">
      <h2>Einstiegsschwelle</h2>

      <p className="bigNumber">
        <span className="bigNumber__value">{setting.score}</span>
        <span className="bigNumber__unit">von 100 Punkten</span>
      </p>

      <p>
        {setting.source === "SAVED"
          ? "Von Ihnen gespeichert."
          : "Ausgelieferte Voreinstellung — noch nichts gespeichert."}{" "}
        Ein Coin wird gekauft, sobald seine Gesamtbewertung diesen Wert erreicht und alle
        uebrigen Tore offen sind. Niedriger heisst mehr Einstiege und schlechtere
        Durchschnittsqualitaet, hoeher heisst seltener und waehlerischer.
      </p>

      {!wirksam && (
        <p className="placeholder" role="status">
          <strong>NOCH NICHT WIRKSAM</strong>
          <br />
          Der letzte Bewertungslauf rechnete noch mit {benutzt}. Der Worker uebernimmt die
          neue Zahl beim naechsten Lauf, ueblicherweise innerhalb einer Minute.
        </p>
      )}

      {angemeldet ? (
        <EntryScoreForm aktuell={setting.score} min={min} max={max} />
      ) : (
        <>
          <h3>Aendern</h3>
          {anmeldungEingerichtet ? (
            <p>
              <a href="/login">Anmelden</a>, dann laesst sich die Zahl hier direkt setzen.
              Die Anzeige ist offen, das Setzen nicht — sonst koennte jeder, der die
              Adresse kennt, Ihre Handelsschwelle verstellen.
            </p>
          ) : (
            <p>
              Es ist kein Passwort hinterlegt. Ohne <code>DASHBOARD_PASSWORD</code> in der
              Umgebung dieser Oberflaeche gibt es keine Anmeldung und damit keine
              Aenderung. <a href="/login">Was zu tun ist</a>.
            </p>
          )}
        </>
      )}

      <p className="hint">
        Die Buchfuehrung bleibt dieselbe: Barbestand, offene Positionen und Verlustgrenzen
        laufen ueber eine Schwellenaenderung hinweg weiter. Nur die Regel, nach der neu
        entschieden wird, aendert sich — und jede Entscheidung bleibt der Schwelle
        zugeordnet, unter der sie gefallen ist.
      </p>
      {setting.updatedAt !== null && (
        <p className="hint">
          Zuletzt geaendert: {setting.updatedAt.toISOString()} durch {setting.updatedBy}.
        </p>
      )}
    </section>
  );
}
