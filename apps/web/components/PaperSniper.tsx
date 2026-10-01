import type { loadPaperSniper } from "@sae/db";
export function PaperSniper({ data }: { data: Awaited<ReturnType<typeof loadPaperSniper>> }) {
  const fresh = data.updatedAt !== null && Date.now() - data.updatedAt.getTime() < 90_000;
  return <section className="panel">
    <h2>PAPER-SNIPER · OFFENSIV / SEHR OFFENSIV</h2>
    <p>Live-Ereignisse für Pump.fun-Starts und Pool-Migrationen. Offensiv ab Score 50, Sehr offensiv ab Score 35; aktuelle Sicherheitsdaten und ausführbare Kauf-/Verkaufsquotes erforderlich. Keine Wartepflicht auf fünf Minuten Kurshistorie.</p>
    <p>Feed: <strong>{fresh ? data.state ?? "UNBEKANNT" : "NICHT AKTUELL"}</strong> · Empfangene Ereignisse: {data.received ?? "—"} · Zur Prüfung: {data.dispatched ?? "—"} · Wartend im Feed: {data.pending ?? "—"} · Wegen Zeit-/Kapazitätslimit verworfen: {data.dropped ?? "—"}</p>
    <p>Letztes Ereignis: {data.lastEvent ?? "noch keines"}. Zähler seit Worker-Start. Budget: höchstens vier neue Kandidaten pro Minute, Migrationen zuerst. Das ist keine vollständige Abdeckung aller Solana-Pools.</p>
    <p>Fehlt nach einem Start noch ein handelbarer Markt oder ein Sicherheitsbericht, wird bis zu viermal erneut geprüft. Käufe, Positionen und Ergebnis erscheinen im jeweiligen Paper-Konto oben.</p>
    <table><thead><tr><th>Konto</th><th>Coin</th><th>Ereignis</th><th>Ergebnis</th><th>Score</th><th>Seit Empfang</th></tr></thead>
      <tbody>{data.jobs.map((j, i) => <tr key={`${j.at.toISOString()}-${i}`}><td>{j.account}</td><td>{j.mint ?? "—"}</td><td>{j.event ?? "—"}</td><td>{j.outcome}</td><td>{j.score ?? "—"}</td><td>{j.latencyMs === null ? "—" : `${Math.round(j.latencyMs / 1000)} s`}</td></tr>)}</tbody></table>
    {data.jobs.length === 0 && <p>Noch kein Launch-Ereignis zur Prüfung eingereiht.</p>}
  </section>;
}
