"use client";

/**
 * Fehlergrenze fuer alles, was oben nicht abgefangen wurde.
 *
 * Ohne diese Datei beantwortet Next.js jeden unbehandelten Wurf einer
 * Server-Komponente mit „Application error: a server-side exception has
 * occurred" — einer Meldung, die dem Betreiber nichts sagt und nicht einmal
 * verraet, ob eine Variable fehlt oder eine Datenbank ausgefallen ist.
 *
 * Diese Grenze ersetzt keine Fehlerbehandlung. Das Dashboard behandelt fehlende
 * Konfiguration und ausgefallene Datenbank ausdruecklich selbst und praeziser.
 * Sie faengt, was danach noch kommt — und sorgt dafuer, dass daraus eine Seite
 * wird statt einer Sammelmeldung.
 *
 * Was hier bewusst NICHT steht: `error.message`. Eine Fehlermeldung aus dem
 * Datenbanktreiber enthaelt die Verbindungszeichenfolge samt Passwort, und
 * diese Komponente rendert im Browser. Die `digest` ist eine von Next.js
 * vergebene Kennung ohne Inhalt — mit ihr laesst sich der volle Eintrag im
 * Server-Log finden, ohne ihn hier auszugeben.
 */

export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): React.ReactNode {
  return (
    <>
      <section className="headline" data-connected={false}>
        <h1>UNERWARTETER FEHLER</h1>
        <p>
          Diese Seite konnte nicht geladen werden. Der Grund steht im Server-Log, nicht
          hier — eine Fehlermeldung aus dem Datenbanktreiber enthaelt die
          Verbindungszeichenfolge.
        </p>
      </section>

      <main className="workspace">
        <section className="panel">
          <h2>Was jetzt hilft</h2>
          <p className="placeholder">
            {error.digest === undefined ? (
              <>Kein Kennzeichen vorhanden. Der Eintrag steht im Server-Log.</>
            ) : (
              <>
                <strong>Kennzeichen {error.digest}</strong>
                <br />
                Damit laesst sich der vollstaendige Eintrag im Server-Log finden.
              </>
            )}
          </p>
          <p className="placeholder">
            Ohne diese Oberflaeche pruefbar: <code>/api/health</code> (laeuft der
            Prozess) und <code>/api/diagnostics/providers</code> (kommt das System an
            Daten).
          </p>
          <button type="button" onClick={reset}>
            Erneut versuchen
          </button>
        </section>
      </main>
    </>
  );
}
