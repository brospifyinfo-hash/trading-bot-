import { formatMoney, money } from "@sae/core";
import { isRecentObservation, type DecisionRunReport } from "@sae/db";

function Counts({ values }: { readonly values: Readonly<Record<string, number>> | null }) {
  if (values === null) return <p>In diesem Lauf nicht aufgezeichnet.</p>;
  if (Object.keys(values).length === 0) return <p>Keine gemeldet.</p>;
  return <ul>{Object.entries(values).sort(([, a], [, b]) => b - a).map(([reason, n]) =>
    <li key={reason}>{reason}: {n}</li>)}</ul>;
}

export function OperatingStatus({ run, now }: {
  readonly run: DecisionRunReport | null;
  readonly now: Date;
}) {
  const fresh = isRecentObservation(run?.finishedAt ?? null, now);
  const sizing = run?.sizing ?? null;
  const amount = (minor: string, currency: "EUR" | "USD") => formatMoney(money(BigInt(minor), currency));
  return <section className="panel">
    <h2>Betriebsdiagnose</h2>
    <p><strong>{run === null ? "Noch kein abgeschlossener Bewertungslauf nachgewiesen."
      : fresh ? "Bewertung wurde kuerzlich ausgefuehrt."
      : "Kein aktueller abgeschlossener Bewertungslauf nachgewiesen."}</strong></p>
    <p>Aktuell bedeutet: Abschluss vor weniger als drei Minuten. Das bestaetigt einen Lauf,
      keinen Kauf und keinen Gewinn. Bei ausbleibenden Laeufen Consumer und Queue pruefen.</p>
    {run !== null && <>
      <p>Letzter Abschluss: {run.finishedAt.toISOString()}</p>
      <dl className="kv">
        <div><dt>Tokens in diesem Lauf geprueft</dt><dd>{run.processed ?? "unbekannt"}</dd></div>
        <div><dt>Tokens in der ausgewaehlten Rotation</dt><dd>{run.tracked ?? "nicht aufgezeichnet"}</dd></div>
        <div><dt>In dieser Runde zuvor bearbeitet</dt><dd>{run.skipped ?? "nicht aufgezeichnet"}</dd></div>
        <div><dt>Runde abgeschlossen</dt><dd>{run.roundComplete === null ? "nicht aufgezeichnet" : run.roundComplete ? "ja" : "nein"}</dd></div>
        <div><dt>Bester Score dieses Laufs</dt><dd>{run.bestScore ?? "nicht berechenbar oder nicht aufgezeichnet"}</dd></div>
        <div><dt>Einstiegsschwelle des Workers</dt><dd>{run.entryThreshold ?? "nicht aufgezeichnet"}</dd></div>
      </dl>
      <h3>Warum zuletzt nicht gekauft?</h3>
      <Counts values={run.outcomes} />
      <h3>Fehlende Pflichtfelder</h3>
      <Counts values={run.missingFields} />
      <p>Ein Token kann mehrere fehlende Felder haben. Die Zahlen oben beschreiben diesen
        Lauf und werden nicht als zusaetzliche Trades oder Gelegenheiten gezaehlt.</p>
      <h3>Passt die Positionsgroesse?</h3>
      {sizing === null ? <p>Noch keine Groessenpruefung vom Worker aufgezeichnet.</p> : <>
        <p><strong>{sizing.tradeable
          ? "Die festen Groessenvorgaben widersprechen sich nicht. Die Marktpruefung bleibt erforderlich."
          : "Einstieg durch widerspruechliche Groessenvorgaben blockiert."}</strong></p>
        <dl className="kv">
          <div><dt>Mindestbetrag</dt><dd>{amount(sizing.minimumMinor, sizing.currency)}</dd></div>
          <div><dt>Obergrenze pro Position</dt><dd>{amount(sizing.portfolioCapMinor, sizing.currency)}</dd></div>
          <div><dt>Obergrenze aus EV-Konfidenz</dt><dd>{amount(sizing.confidenceCapMinor, sizing.currency)}</dd></div>
          <div><dt>Hoechstens moeglich vor Liquiditaetspruefung</dt><dd>{amount(sizing.maximumMinor, sizing.currency)}</dd></div>
        </dl>
        <p>Das sind konfigurierte Papierbetraege aus dem letzten Lauf, keine Kontostaende.
          Einsatzgrenze und Gewinnziel sind verschiedene Einstellungen.
          Bei einem Widerspruch muessen die Groessenvorgaben gemeinsam entschieden werden.</p>
      </>}
    </>}
  </section>;
}
