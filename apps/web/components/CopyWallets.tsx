"use client";

import { useActionState } from "react";

import type { CopyWalletRow } from "@sae/db";
import { walletEntfernen, walletSchalten, walletsHinzufuegen } from "@/app/actions";
import { CopyButton } from "@/components/CopyButton";

/**
 * Die Vorbild-Wallets.
 *
 * Ein Textfeld statt eines Eingabefelds, und das ist der Punkt der Uebung:
 * Adressen kommen in Rudeln. Fuenf Felder nacheinander auszufuellen ist
 * dasselbe in zehnmal laenger.
 *
 * Was unleserlich war, steht in der Rueckmeldung — nicht als „n Fehler",
 * sondern woertlich. Eine Adresse mit einem Tippfehler sieht in einer Liste
 * aus wie eine Wallet, die einfach nicht handelt, und das haelt man monatelang
 * fuer eine Eigenschaft der Wallet.
 */
function kurz(adresse: string): string {
  return `${adresse.slice(0, 4)}…${adresse.slice(-4)}`;
}

function Schalter({ wallet }: { readonly wallet: CopyWalletRow }) {
  const [meldung, formAction, laeuft] = useActionState(walletSchalten, null);
  return (
    <form action={formAction} className="sell">
      <input type="hidden" name="adresse" value={wallet.address} />
      <input type="hidden" name="aktiv" value={wallet.active ? "nein" : "ja"} />
      <button
        type="submit"
        className={wallet.active ? "sell__button" : "sell__button sell__button--pending"}
        disabled={laeuft}
      >
        {laeuft ? "…" : wallet.active ? "Anhalten" : "Aufnehmen"}
      </button>
      {meldung !== null && <small className="sell__note">{meldung}</small>}
    </form>
  );
}

function Entfernen({ wallet }: { readonly wallet: CopyWalletRow }) {
  const [meldung, formAction, laeuft] = useActionState(walletEntfernen, null);
  return (
    <form action={formAction} className="sell">
      <input type="hidden" name="adresse" value={wallet.address} />
      <button type="submit" className="sell__button" disabled={laeuft}>
        {laeuft ? "…" : "Entfernen"}
      </button>
      {meldung !== null && <small className="sell__note">{meldung}</small>}
    </form>
  );
}

export function CopyWallets({
  wallets,
  aenderbar,
  geschuetzt,
  max,
  kopiererLaeuft,
}: {
  readonly wallets: readonly CopyWalletRow[];
  readonly aenderbar: boolean;
  readonly geschuetzt: boolean;
  readonly max: number;
  /**
   * Liest der Worker diese Liste schon?
   *
   * Steht das auf `false`, ist die Liste eine Liste und sonst nichts. Das MUSS
   * hier stehen: eine gepflegte Liste, von der niemand kopiert, sieht genauso
   * aus wie eine, die funktioniert — dieselbe stille Null wie in §140 und
   * §144.
   */
  readonly kopiererLaeuft: boolean;
}) {
  const [meldung, formAction, laeuft] = useActionState(walletsHinzufuegen, null);
  const aktive = wallets.filter((w) => w.active).length;

  return (
    <section className="panel">
      <h2>Vorbild-Wallets</h2>
      <p>
        Adressen, deren Käufe der Bot nachbilden soll. Mehrere auf einmal: eine pro Zeile,
        oder durch Komma getrennt. Ein Name ist optional —{" "}
        <code>Adresse = Name</code>.
      </p>

      {!kopiererLaeuft && (
        <p className="placeholder" role="status">
          <strong>LISTE WIRD NOCH NICHT GELESEN</strong>
          <br />
          Die Liste lässt sich jetzt pflegen, aber es kopiert noch niemand von ihr. Dafür
          fehlt der Zugang zur Kette: der Kopierer liest die Swaps einer Wallet über{" "}
          <code>SOLANA_RPC_URL</code>, und solange die nicht hinterlegt ist, bleibt diese
          Liste eine Liste. Das steht hier, damit eine gepflegte Liste nicht wie ein
          laufender Kopierer aussieht.
        </p>
      )}

      {wallets.length === 0 ? (
        <p className="placeholder">
          <strong>KEINE WALLET HINTERLEGT</strong>
          <br />
          Noch kein Vorbild. Ohne Eintrag kopiert der Bot nichts — er entscheidet dann
          ausschließlich nach seinen eigenen Regeln.
        </p>
      ) : (
        <div className="paper-table">
          <table>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Name</th>
                <th>Status</th>
                <th>Kopiert</th>
                <th>Zuletzt gelesen</th>
                {aenderbar && <th>Aktion</th>}
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address} data-pending={w.active ? undefined : "true"}>
                  <td>
                    <span className="mint-cell">
                      <span className="paper-mint" title={w.address}>
                        {kurz(w.address)}
                      </span>
                      <CopyButton value={w.address} label="Adresse" />
                    </span>
                  </td>
                  <td>{w.label ?? "—"}</td>
                  <td className="status">{w.active ? "AKTIV" : "ANGEHALTEN"}</td>
                  <td>
                    <strong>{w.copiedCount}</strong>
                  </td>
                  <td>{w.lastCheckedAt?.toISOString() ?? "nie"}</td>
                  {aenderbar && (
                    <td>
                      <Schalter wallet={w} />
                      {w.copiedCount === 0 && <Entfernen wallet={w} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {aenderbar ? (
        <>
          <h3>Hinzufügen</h3>
          <form action={formAction} className="form">
            <label className="field">
              <span>Adressen ({aktive} von höchstens {max} aktiv)</span>
              <textarea
                name="adressen"
                rows={4}
                spellCheck={false}
                placeholder={"7igLKzSzdFWZwno55o7n9pesZyG1Ban4QCXLkaeweWuy\n…weitere Adresse = Name"}
              />
            </label>
            <button type="submit" disabled={laeuft}>
              {laeuft ? "Speichere…" : "Hinzufügen"}
            </button>
          </form>
          {meldung !== null && (
            <p className="placeholder" role="status">
              <strong>HINWEIS</strong>
              <br />
              {meldung}
            </p>
          )}
        </>
      ) : (
        <p className="hint">
          {geschuetzt
            ? "Zum Ändern anmelden."
            : "Diese Liste lässt sich hier nicht ändern."}
        </p>
      )}

      <p className="hint">
        <strong>Was Kopieren hier heißt und was nicht.</strong> Übernommen wird ein KAUF,
        nachdem er auf der Kette steht — also immer später und zu einem anderen Preis als
        beim Vorbild. Das ist keine Einschränkung der Umsetzung, sondern die Natur der
        Sache: wer kopiert, ist zweiter. Verkäufe folgen den eigenen Ausstiegsregeln des
        Bots, nicht denen des Vorbilds.
      </p>
      <p className="hint">
        Kopierte Trades laufen als EIGENES Konto und werden getrennt ausgewertet. Sonst
        stünde später in einer einzigen Zahl, wie gut „der Bot" ist, und niemand könnte
        mehr sagen, welcher Teil davon eine fremde Entscheidung war.
      </p>
      <p className="hint">
        Eine Wallet mit Historie wird ausdrücklich NICHT rückwirkend kopiert. Es beginnt ab
        dem Hinzufügen — alles andere wäre Handeln mit Preisen von gestern.
      </p>
    </section>
  );
}
