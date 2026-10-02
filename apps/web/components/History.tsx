import type { PaperTrading as TradingState, SettingChange } from "@sae/db";

import { CopyButton } from "./CopyButton";
import { paperMoney } from "./PaperTrading";

/**
 * Was der Bot getan hat, in der Reihenfolge, in der er es getan hat.
 *
 * Die beiden bestehenden Tabellen zeigen offene und geschlossene Positionen
 * getrennt. Fuer die Frage „was ist passiert" ist das die falsche Sortierung:
 * ein Kauf um 14:02 und der Verkauf um 14:19 gehoeren nebeneinander, nicht in
 * zwei Abschnitte.
 *
 * Dazu die Aenderungen an den Einstellungen. Eine Reihe von Trades ohne sie
 * ist nicht auswertbar: „warum sind an diesem Nachmittag zwanzig Positionen
 * entstanden" beantwortet keine Trade-Liste, sondern die Zeile „Schwelle von
 * 70 auf 10".
 *
 * Jede Zeile traegt ausserdem die Strategieversion. Sie enthaelt Schwelle und
 * Modus (`2.0.0-s10-offensiv`), also die Regel, unter der dieser Trade
 * entstand. Ohne sie waere eine Statistik aus vorsichtigen und offensiven
 * Einstiegen ein Mischwert ohne Bedeutung.
 */

const zeit = (at: Date): string =>
  at.toLocaleString("de-DE", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium" });

/** Die Regel hinter einem Trade, aus dem Versionsnamen gelesen. */
function regel(version: string): string {
  const treffer = /^2\.0\.0-s(\d{1,3})(-offensiv)?$/.exec(version);
  if (treffer === null) return version;
  return `Schwelle ${treffer[1] ?? "?"} · ${treffer[2] === undefined ? "vorsichtig" : "offensiv"}`;
}

interface Ereignis {
  readonly key: string;
  readonly at: Date;
  readonly art: "KAUF" | "VERKAUF";
  readonly symbol: string;
  readonly mint: string;
  readonly einsatzMinor: bigint;
  readonly ergebnisMinor: bigint | null;
  readonly grund: string | null;
  readonly version: string;
}

export function History({
  data,
  settings,
}: {
  readonly data: TradingState;
  readonly settings: readonly SettingChange[];
}) {
  const ereignisse: Ereignis[] = [];

  if (data.kind === "READY") {
    for (const { position: p, token, version } of [...data.open, ...data.closed]) {
      const symbol = token.symbol ?? token.name ?? "Unbekannt";
      ereignisse.push({
        key: `${p.id}-kauf`, at: p.openedAt, art: "KAUF", symbol, mint: token.mint,
        einsatzMinor: p.entryNotionalMinor, ergebnisMinor: null, grund: null, version,
      });
      if (p.closedAt !== null) {
        ereignisse.push({
          key: `${p.id}-verkauf`, at: p.closedAt, art: "VERKAUF", symbol, mint: token.mint,
          einsatzMinor: p.entryNotionalMinor,
          ergebnisMinor: p.realizedPnlMinor - p.costsPaidMinor,
          grund: p.exitReason, version,
        });
      }
    }
  }
  ereignisse.sort((a, b) => b.at.getTime() - a.at.getTime() || a.key.localeCompare(b.key));

  return (
    <section className="panel paper-account">
      <h2>Verlauf</h2>
      <p>
        Jede Buchung des Papier-Kontos in zeitlicher Reihenfolge, neueste zuerst — und
        darunter jede Änderung an den Einstellungen. Zusammen gelesen beantworten die
        beiden, was der Bot getan hat und unter welcher Regel.
      </p>

      <h3>Buchungen ({ereignisse.length})</h3>
      {ereignisse.length === 0 ? (
        <p>
          Noch keine Buchung. Hier erscheint jeder Kauf und jeder Verkauf, sobald der Bot
          einen ausführt.
        </p>
      ) : (
        <div className="paper-table">
          <table>
            <thead>
              <tr>
                <th>Zeit (UTC)</th>
                <th>Was</th>
                <th>Coin</th>
                <th>Adresse</th>
                <th>Einsatz</th>
                <th>Ergebnis netto</th>
                <th>Grund</th>
                <th>Regel</th>
              </tr>
            </thead>
            <tbody>
              {ereignisse.map((e) => (
                <tr key={e.key}>
                  <td>{zeit(e.at)}</td>
                  <td>
                    <span className={`pill ${e.art === "KAUF" ? "paper" : "ok"}`}>
                      {e.art === "KAUF" ? "gekauft" : "verkauft"}
                    </span>
                  </td>
                  <td>
                    <strong>{e.symbol}</strong>
                  </td>
                  <td>
                    <span className="mint-cell">
                      <a
                        href={`https://solscan.io/token/${e.mint}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="paper-mint"
                        title={e.mint}
                      >
                        {e.mint.slice(0, 4)}…{e.mint.slice(-4)}
                      </a>
                      <CopyButton value={e.mint} label="Mint-Adresse" />
                    </span>
                  </td>
                  <td>{paperMoney(e.einsatzMinor)}</td>
                  <td
                    className={
                      e.ergebnisMinor === null
                        ? ""
                        : e.ergebnisMinor < 0n
                          ? "paper-negative"
                          : "paper-positive"
                    }
                  >
                    {e.ergebnisMinor === null ? "—" : paperMoney(e.ergebnisMinor)}
                  </td>
                  <td>{e.grund ?? "—"}</td>
                  <td className="paper-mint">{regel(e.version)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Änderungen an den Einstellungen ({settings.length})</h3>
      {settings.length === 0 ? (
        <p>Noch nichts geändert. Es gilt durchgehend, was gespeichert ist.</p>
      ) : (
        <div className="paper-table">
          <table>
            <thead>
              <tr>
                <th>Zeit (UTC)</th>
                <th>Schwelle</th>
                <th>Modus</th>
                <th>Einsatz je Trade</th>
                <th>Durch</th>
              </tr>
            </thead>
            <tbody>
              {settings.map((s) => (
                <tr key={`${s.at.toISOString()}-${String(s.scoreNach)}`}>
                  <td>{zeit(s.at)}</td>
                  <td>
                    {s.scoreVon === null ? "—" : s.scoreVon} → <strong>{s.scoreNach ?? "—"}</strong>
                  </td>
                  <td>
                    {s.modusVon === null ? "—" : s.modusVon.toLowerCase()} →{" "}
                    <strong>{s.modusNach === null ? "—" : s.modusNach.toLowerCase()}</strong>
                  </td>
                  <td>
                    {s.einsatzVon === null ? "Risikobudget" : paperMoney(s.einsatzVon)} →{" "}
                    <strong>
                      {s.einsatzNach === null ? "Risikobudget" : paperMoney(s.einsatzNach)}
                    </strong>
                  </td>
                  <td className="paper-mint">{s.durch ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
