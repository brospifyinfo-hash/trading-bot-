/**
 * Das Feld fuer die Frage „warum DIESER Coin nicht?".
 *
 * Ein gewoehnliches GET-Formular, kein Client-Code: die Antwort ist eine
 * Seite, die man verschicken und neu laden kann. Eine Suche, deren Ergebnis
 * nur im Speicher eines Browsers existiert, taugt nicht fuer eine Frage, die
 * man jemandem zeigen will.
 */
export function CoinLookup({ wert = "" }: { readonly wert?: string }) {
  return (
    <section className="panel">
      <h2>Warum dieser Coin nicht?</h2>
      <p>
        Adresse oder DexScreener-Link einsetzen. Die Antwort geht Tor für Tor durch, was
        die gespeicherten Daten sagen — gemessen gegen Ihre <strong>aktuellen</strong>{" "}
        Einstellungen.
      </p>
      <form action="/coin" method="get" className="form form--inline">
        <label className="field field--wide">
          <span>Adresse oder Link</span>
          <input
            type="text"
            name="mint"
            defaultValue={wert}
            placeholder="https://dexscreener.com/solana/…"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <button type="submit">Nachsehen</button>
      </form>
      <p className="hint">
        DexScreener-Links tragen die Adresse des HANDELSPAARS, nicht die des Coins. Beide
        werden gefunden; welcher Weg es war, steht in der Antwort.
      </p>
    </section>
  );
}
