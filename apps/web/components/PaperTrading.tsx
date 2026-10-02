import type { PaperTrading as TradingState } from "@sae/db";
import { CopyButton } from "./CopyButton";
import { SellButton } from "./SellButton";
import { PaperRefresh } from "./PaperRefresh";

export function paperMoney(minor: bigint, currency = "EUR") {
  const sign = minor < 0n ? "−" : "";
  const value = minor < 0n ? -minor : minor;
  return `${sign}${(value / 100n).toLocaleString("de-DE")},${(value % 100n).toString().padStart(2, "0")} ${currency}`;
}
const date = (at: Date) => at.toLocaleString("de-DE", { timeZone: "UTC" }) + " UTC";

export function PaperTrading({ data, label = "Standard", description, refresh = true }: { readonly data: TradingState; readonly label?: string; readonly description?: string; readonly refresh?: boolean }) {
  return <section className="panel paper-account">
    <div className="paper-heading"><h2>Paper-Konto · {label}</h2>{refresh && <PaperRefresh />}</div>
    <p>Simulierter Handel mit Solana-Tokens über Jupiter-Router-Quotes. Kein echtes Geld.
      Alle Konten handeln unabhängig mit jeweils eigenem Startkapital.</p>
    {description && <p>{description}</p>}
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
      Offene Bestände zählen hier zum verbleibenden Einstandswert; der unrealisierte Stand steht je Position in der Tabelle darunter.</p>
    <h3>Offene Positionen ({data.open.length})</h3>
    {data.open.length === 0 ? <p>Noch keine offenen Positionen. Käufe erscheinen hier, sobald die Strategie einen Einstieg ausführt.</p>
      : <>
        <div className="paper-table"><table><thead><tr>
          <th>Coin</th><th>Adresse</th><th>Eröffnet (UTC)</th><th>Einsatz</th><th>Rest</th>
          <th>Aktueller Stand</th><th>Kurs&nbsp;±</th><th>Realisiert netto</th><th></th>
        </tr></thead>
        <tbody>{data.open.map(({ position: p, token }) => {
          const stand = data.live.get(p.id);
          return <tr key={p.id} data-pending={p.closeRequestedAt !== null ? "true" : undefined}>
            <td><strong>{token.symbol ?? token.name ?? "Unbekannter Token"}</strong></td>
            <td><span className="mint-cell"><a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer noopener" className="paper-mint" title={token.mint}>{token.mint.slice(0, 4)}…{token.mint.slice(-4)}</a><CopyButton value={token.mint} label="Mint-Adresse" /></span></td>
            <td>{date(p.openedAt)}</td>
            <td>{fmt(p.entryNotionalMinor)}</td>
            <td>{(Number(p.remainingAmountRaw * 10000n / p.entryAmountRaw) / 100).toLocaleString("de-DE")} %</td>
            {stand === undefined || stand.kind === "UNKNOWN"
              ? <><td className="muted" colSpan={2}>{stand === undefined ? "nicht messbar"
                  : stand.reason === "KEIN_AKTUELLER_KURS" ? "kein aktueller Kurs"
                  : stand.reason === "KEIN_EINSTIEGSKURS" ? "kein Einstiegskurs gespeichert"
                  : "kein Restbestand"}</td></>
              : <>
                <td className={stand.unrealisiertMinor < 0n ? "paper-negative" : "paper-positive"}>
                  <strong>{stand.unrealisiertMinor >= 0n ? "+" : ""}{fmt(stand.unrealisiertMinor)}</strong>
                  <small className="paper-mint">Wert {fmt(stand.wertJetztMinor)} · Kurs {stand.kursAlterSekunden} s alt</small>
                </td>
                <td className={stand.verhaeltnis < 1 ? "paper-negative" : "paper-positive"}>
                  {stand.verhaeltnis >= 1 ? "+" : "−"}{(Math.abs(stand.verhaeltnis - 1) * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %
                </td>
              </>}
            <td>{fmt(p.realizedPnlMinor - p.costsPaidMinor)}</td>
            <td><SellButton positionId={p.id} angefordertAm={p.closeRequestedAt} /></td>
          </tr>;
        })}</tbody></table></div>
        <p className="hint">„Aktueller Stand" ist der unrealisierte Gewinn oder Verlust: Kurs jetzt
          gegen Kurs beim Einstieg, angewendet auf den noch im Markt stehenden Einsatz. Beide Kurse
          stammen aus derselben Snapshot-Reihe; fehlt einer, steht „nicht messbar" statt einer Null.
          Das Kursalter steht daneben — ein Stand von vor einer halben Stunde ist bei Memecoins keine
          Auskunft über das Jetzt.</p>
        <p className="hint">„Verkaufen" fordert den Verkauf an. Ausgeführt wird er vom Worker im
          nächsten Takt, mit echtem Router-Quote. Diese Oberfläche schließt die Position nicht selbst —
          sie müsste dafür einen Ausstiegskurs erfinden.</p>
      </>}
    <h3>Vergangene Trades ({data.closedCount})</h3>
    {data.closedCount === 0 ? <p>Noch keine abgeschlossenen Trades.</p>
      : <div className="paper-table"><table><thead><tr><th>Coin</th><th>Eröffnet (UTC)</th><th>Geschlossen (UTC)</th><th>Einsatz</th><th>Kosten</th><th>Ergebnis netto</th><th>Ausstiegsgrund</th></tr></thead>
        <tbody>{data.closed.map(({ position: p, token }) => <tr key={p.id}>
          <td><strong>{token.symbol ?? token.name ?? "Unbekannter Token"}</strong><span className="mint-cell"><a href={`https://solscan.io/token/${token.mint}`} target="_blank" rel="noreferrer noopener" className="paper-mint" title={token.mint}>{token.mint.slice(0, 4)}…{token.mint.slice(-4)}</a><CopyButton value={token.mint} label="Mint-Adresse" /></span></td>
          <td>{date(p.openedAt)}</td><td>{date(p.closedAt!)}</td><td>{fmt(p.entryNotionalMinor)}</td>
          <td>{fmt(p.costsPaidMinor)}</td><td className={p.realizedPnlMinor - p.costsPaidMinor < 0n ? "paper-negative" : "paper-positive"}>{fmt(p.realizedPnlMinor - p.costsPaidMinor)}</td>
          <td>{p.exitReason ?? "—"}</td>
        </tr>)}</tbody></table></div>}
    {data.closedCount > 100 && <p>Die letzten 100 Trades werden angezeigt. Das Gesamtergebnis umfasst die gesamte Historie.</p>}
  </>;
}
