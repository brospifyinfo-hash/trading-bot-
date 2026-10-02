/**
 * Laeuft der Worker ueberhaupt?
 *
 * Die Frage, die auf dieser Seite ganz oben stehen muss und bis hierher im
 * vierten Panel versteckt war. Der Anlass ist ein echter Fehlschluss:
 *
 * Die Railway-Testphase war abgelaufen, alle drei Dienste standen still, und
 * der letzte Bewertungslauf war 24 Stunden alt. Das Dashboard zeigte
 * trotzdem Ergebnisse — Zahl der geprueften Coins, Ablehnungsgruende,
 * „DIE SCHWELLE HAT NICHTS ENTSCHIEDEN" — alles im Praesens und alles aus
 * diesem einen alten Lauf. Daraus liess sich mit bestem Willen nur ein
 * falscher Schluss ziehen: dass der Bot laeuft und ablehnt. Er lief nicht.
 *
 * Eine Oberflaeche, die alte Zahlen zeigt, ist in Ordnung. Eine, die sie
 * zeigt, ohne ihr Alter zu nennen, behauptet etwas ueber die Gegenwart.
 */
function dauer(ms: number): string {
  const sekunden = Math.floor(ms / 1_000);
  if (sekunden < 90) return `${String(sekunden)} Sekunden`;
  const minuten = Math.floor(sekunden / 60);
  if (minuten < 90) return `${String(minuten)} Minuten`;
  const stunden = Math.floor(minuten / 60);
  if (stunden < 48) return `${String(stunden)} Stunden`;
  return `${String(Math.floor(stunden / 24))} Tagen`;
}

export function WorkerStatus({
  alive,
  lastRunAt,
  lastSampleAt,
  now,
}: {
  readonly alive: boolean;
  readonly lastRunAt: Date | null;
  readonly lastSampleAt: Date | null;
  readonly now: Date;
}) {
  if (alive) return null;

  // Der juengste Lebenszeichen-Zeitpunkt, den es gibt. Keiner davon ist ein
  // Beweis fuer einen laufenden Prozess — aber ihr Alter ist einer gegen ihn.
  const zuletzt = [lastRunAt, lastSampleAt]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <section className="panel alarm-banner" data-tone="alarm">
      <h2>Der Bot laeuft nicht</h2>
      <p>
        <strong>
          {zuletzt === undefined
            ? "Es liegt kein einziges Lebenszeichen des Workers vor."
            : `Letztes Lebenszeichen vor ${dauer(now.getTime() - zuletzt.getTime())} (${zuletzt.toISOString()}).`}
        </strong>
      </p>
      <p>
        Alles weiter unten auf dieser Seite stammt aus dieser Zeit. Es sagt nichts darueber
        aus, was der Bot jetzt tut — er tut nichts. Insbesondere beweist keine
        Ablehnungsstatistik und keine Einstiegsschwelle von hier etwas ueber die Gegenwart.
      </p>
      <p className="hint">
        Haeufigste Ursachen in dieser Reihenfolge: der Hosting-Plan des Workers ist
        abgelaufen oder ausgesetzt, der Dienst hat kein aktives Deployment, oder er stuerzt
        beim Start ab. Die ersten zwei stehen beim Hoster, der dritte in dessen Logs.
      </p>
    </section>
  );
}
