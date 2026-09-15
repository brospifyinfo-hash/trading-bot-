import type { PaperTrading as TradingState } from "@sae/db";
import { PaperRefresh } from "./PaperRefresh";

export function paperMoney(minor: bigint, currency = "EUR") {
  const sign = minor < 0n ? "−" : "";
  const value = minor < 0n ? -minor : minor;
  return `${sign}${(value / 100n).toLocaleString("de-DE")},${(value % 100n).toString().padStart(2, "0")} ${currency}`;
}
const date = (at: Date) => at.toLocaleString("de-DE", { timeZone: "UTC" }) + " UTC";

export function PaperTrading({ data }: { readonly data: TradingState }) {
  return <section className="panel paper-account">
    <div className="paper-heading"><h2>Mein Paper-Konto</h2><PaperRefresh /></div>
    <p>Simulierter Handel mit Solana-Tokens über Jupiter-Router-Quotes. Kein echtes Geld.
      Konto der Strategie memecoin-risk-managed; manuelle Trades und Testdaten sind separat.</p>
    <p className="muted">Datenstand: {date(data.updatedAt)}</p>
    {data.kind !== "READY" ? <p role="status">{data.kind === "WAITING"
      ? "Das Paper-Konto wurde vom Worker noch nicht initialisiert."
      : "Die Kontobuchungen sind nicht vollständig abgleichbar. Guthaben und Ergebnis sind derzeit unbekannt."}</p>
      : <Account data={data} />}
  </section>;
}

function Account({ data }: { data: Extract<TradingState, { kind: "READY" }> }) {
  const { account } = data;
  const fmt = (n: bigint) => paperMoney(n, account.cash.currency);
  const net = account.bookValue.minor - data.initialCash.minor;
  const metrics = [
    ["Paper-Guthaben · verfügbar", account.cash.minor],
    ["In Positionen gebunden", account.bookValue.minor - account.cash.minor],
    ["Gesamtergebnis · netto", net],
    ["Heute · netto (UTC)", account.portfolio.realizedTodayPnl.minor],
  ] as const;
  return <>
    <div className="paper-metrics">{metrics.map(([label, value]) =>
      <div className="paper-metric" key={label}><div className="label">{label}</div>
        <strong className={label.includes("netto") ? value < 0n ? "paper-negative" : "paper-positive" : ""}>{fmt(value)}</strong>
      </div>)}</div>
    <p className="muted">Virtuelles Startkapital: {fmt(data.initialCash.minor)}.
      Nettoergebnis = realisierte Gewinne/Verluste abzüglich aller gebuchten Kosten, einschließlich fehlgeschlagener Kaufversuche.
      Offene Bestände zählen zum verbleibenden Einstandswert; unrealisierte Kursgewinne sind nicht enthalten.</p>
    <h3>Offene Positionen ({data.open.length})</h3>
    {data.open.length === 0 ? <p>Noch keine offenen Positionen. Käufe erscheinen hier, sobald die Strategie einen Einstieg ausführt.</p>
      : <div className="paper-table"><table><thead><tr><th>Coin</th><th>Eröffnet (UTC)</th><th>Einsatz</th><th>Restbestand</th><th>Kosten bisher</th><th>Realisiert netto</th></tr></thead>
        <tbody>{data.open.map(({ position: p, token }) => <tr key={p.id}>
          <td><strong>{token.symbol ?? token.name ?? "Unbekannter Token"}</strong><small className="paper-mint">{token.mint}</small></td>
          <td>{date(p.openedAt)}</td><td>{fmt(p.entryNotionalMinor)}</td>
          <td>{(Number(p.remainingAmountRaw * 10000n / p.entryAmountRaw) / 100).toLocaleString("de-DE")} %</td>
          <td>{fmt(p.costsPaidMinor)}</td><td>{fmt(p.realizedPnlMinor - p.costsPaidMinor)}</td>
        </tr>)}</tbody></table></div>}
    <h3>Vergangene Trades ({data.closedCount})</h3>
    {data.closedCount === 0 ? <p>Noch keine abgeschlossenen Trades.</p>
      : <div className="paper-table"><table><thead><tr><th>Coin</th><th>Eröffnet (UTC)</th><th>Geschlossen (UTC)</th><th>Einsatz</th><th>Kosten</th><th>Ergebnis netto</th><th>Ausstiegsgrund</th></tr></thead>
        <tbody>{data.closed.map(({ position: p, token }) => <tr key={p.id}>
          <td><strong>{token.symbol ?? token.name ?? "Unbekannter Token"}</strong><small className="paper-mint">{token.mint}</small></td>
          <td>{date(p.openedAt)}</td><td>{date(p.closedAt!)}</td><td>{fmt(p.entryNotionalMinor)}</td>
          <td>{fmt(p.costsPaidMinor)}</td><td className={p.realizedPnlMinor - p.costsPaidMinor < 0n ? "paper-negative" : "paper-positive"}>{fmt(p.realizedPnlMinor - p.costsPaidMinor)}</td>
          <td>{p.exitReason ?? "—"}</td>
        </tr>)}</tbody></table></div>}
    {data.closedCount > 100 && <p>Die letzten 100 Trades werden angezeigt. Das Gesamtergebnis umfasst die gesamte Historie.</p>}
  </>;
}
