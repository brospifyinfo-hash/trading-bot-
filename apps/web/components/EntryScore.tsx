import type { DecisionRunReport, EntryScoreSetting } from "@sae/db";

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
  run,
  laufAktuell,
  aenderbar,
  geschuetzt,
  min,
  max,
}: {
  readonly setting: EntryScoreSetting;
  readonly benutzt: number | null;
  /** Der letzte Lauf — fuer die Frage, ob die Schwelle ueberhaupt gewirkt hat. */
  readonly run: DecisionRunReport | null;
  /**
   * Ist dieser Lauf aktuell?
   *
   * Ohne diese Angabe wurde hier eine Aussage ueber die Gegenwart aus einem 24
   * Stunden alten Lauf gebildet: „im letzten Lauf kam bei keinem Coin eine
   * Bewertung zustande" las sich wie „der Bot lehnt gerade alles ab", waehrend
   * der Worker in Wahrheit stillstand. Eine alte Zahl zu zeigen ist in
   * Ordnung; aus ihr eine Diagnose zu formen ist es nicht.
   */
  readonly laufAktuell: boolean;
  /** Darf hier gerade geaendert werden — offen oder angemeldet. */
  readonly aenderbar: boolean;
  /** Ist ein Passwort hinterlegt? Entscheidet nur, WAS hier zu lesen ist. */
  readonly geschuetzt: boolean;
  readonly min: number;
  readonly max: number;
}) {
  const wirksam = benutzt === null || benutzt === setting.score;
  /**
   * Hat die Schwelle im letzten Lauf ueberhaupt etwas entschieden?
   *
   * Die Frage, die hier gefehlt hat — und ihr Fehlen hat den Betreiber 24
   * Stunden kosten lassen: er stellte die Schwelle auf 10, es wurde nichts
   * gekauft, und nichts sagte, dass die Zahl in dieser Lage voellig
   * wirkungslos ist. Kommt bei keinem Coin eine Gesamtbewertung zustande,
   * wird die Schwelle nie verglichen — die Ablehnung passiert vorher.
   *
   * `bestScore` ist der hoechste Score des Laufs. Ist er `null`, obwohl Coins
   * geprueft wurden, hatte kein einziger vollstaendige Pflichtdaten.
   */
  const ohneWirkung =
    laufAktuell && run !== null && run.bestScore === null && (run.processed ?? 0) > 0;
  /** Es gibt einen Lauf, aber er ist alt. Dann traegt er keine Diagnose. */
  const laufVeraltet = run !== null && !laufAktuell;

  return (
    <section className="panel">
      <h2>Einstiegsschwelle</h2>

      <p className="bigNumber">
        <span className="bigNumber__value">{setting.score}</span>
        <span className="bigNumber__unit">von 100 Punkten</span>
      </p>

      <p>
        <strong>
          Einsatz je Trade:{" "}
          {setting.entryNotionalMinor === null
            ? "nach Risikobudget"
            : `bis ${(Number(setting.entryNotionalMinor) / 100).toLocaleString("de-DE")} EUR`}
        </strong>
      </p>

      <p>
        <strong>
          {setting.mode === "OFFENSIV"
            ? "Modus: offensiv — entscheidet mit Teildaten."
            : "Modus: vorsichtig — nur mit vollständigen Pflichtdaten."}
        </strong>
      </p>

      {setting.mode === "OFFENSIV" && (
        <p className="hint">
          Fehlende Angaben halten den Bot nicht mehr auf: der Score wird aus dem gebildet,
          was bekannt ist, und seine Abdeckung steht in der Betriebsdiagnose. Gemessene
          schlechte Werte bremsen weiterhin — und vier Dinge bleiben zu: aktive Mint- oder
          Freeze-Autoritaet, nicht gesperrte Liquiditaet, Risikostufe CRITICAL. Das sind
          keine Wissenslucken, sondern Befunde. Positionen aus diesem Modus laufen unter
          einer eigenen Strategieversion, damit die Statistik beide Modi auseinanderhalten
          kann.
        </p>
      )}

      <p>
        {setting.source === "SAVED"
          ? "Von Ihnen gespeichert."
          : "Ausgelieferte Voreinstellung — noch nichts gespeichert."}{" "}
        Ein Coin wird gekauft, sobald seine Gesamtbewertung diesen Wert erreicht und alle
        uebrigen Tore offen sind. Niedriger heisst mehr Einstiege und schlechtere
        Durchschnittsqualitaet, hoeher heisst seltener und waehlerischer.
      </p>

      {ohneWirkung && (
        <p className="placeholder" role="status">
          <strong>DIE SCHWELLE HAT NICHTS ENTSCHIEDEN</strong>
          <br />
          Im letzten Lauf wurden {run?.processed ?? 0} Coins geprueft und bei keinem kam
          eine Gesamtbewertung zustande. Dann wird die Schwelle gar nicht verglichen: ein
          Coin mit unvollstaendigen Pflichtdaten wird abgelehnt, bevor es um die Zahl geht.
          Eine Aenderung hier bewirkt in dieser Lage nichts — auch nicht nach unten.
          Der Grund steht in der Betriebsdiagnose unter „Fehlende erhobene Datenfelder".
        </p>
      )}

      {laufVeraltet && (
        <p className="placeholder" role="status">
          <strong>KEIN AKTUELLER LAUF</strong>
          <br />
          Der letzte Bewertungslauf ist von {run.finishedAt.toISOString()}. Ob diese
          Schwelle etwas bewirkt, ist daran nicht ablesbar — sie wurde seitdem nicht
          angewendet.
        </p>
      )}

      {!wirksam && !laufVeraltet && (
        <p className="placeholder" role="status">
          <strong>NOCH NICHT WIRKSAM</strong>
          <br />
          Der letzte Bewertungslauf rechnete noch mit {benutzt}. Der Worker uebernimmt die
          neue Zahl beim naechsten Lauf, ueblicherweise innerhalb einer Minute.
        </p>
      )}

      {aenderbar ? (
        <EntryScoreForm
          aktuell={setting.score}
          modus={setting.mode}
          einsatzMinor={setting.entryNotionalMinor}
          min={min}
          max={max}
        />
      ) : (
        <>
          <h3>Aendern</h3>
          <p>
            <a href="/login">Anmelden</a>, dann laesst sich die Zahl hier direkt setzen.
          </p>
        </>
      )}

      {!geschuetzt && (
        <p className="hint">
          Diese Seite verlangt kein Passwort: wer die Adresse kennt, kann die Schwelle
          aendern. Das ist so eingerichtet und bei Papierhandel vertretbar — es gibt kein
          Kapital, keine Wallet und keine Live-Freigabe, aenderbar ist genau diese eine
          Zahl zwischen {min} und {max}, und jede Aenderung steht in der
          Aenderungsspur. Soll es ein Passwort verlangen, genuegt{" "}
          <code>DASHBOARD_PASSWORD</code> in der Umgebung dieser Oberflaeche —{" "}
          <a href="/login">Anleitung</a>. Eine Codeaenderung braucht es dafuer nicht.
        </p>
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
