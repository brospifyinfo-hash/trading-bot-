"use client";

import { useActionState } from "react";

import { schwelleSetzen } from "@/app/actions";

/**
 * Das Feld, in dem die Schwelle gesetzt wird.
 *
 * Die Knoepfe fuer 10, 35, 50 und 70 sind Abkuerzungen und keine Auswahl: das
 * Zahlenfeld daneben nimmt jede Zahl zwischen den Grenzen. Eine feste Auswahl
 * waere bequemer zu bauen und haette genau das weggenommen, worum es ging.
 *
 * Geprueft wird trotzdem auf dem Server. `min`/`max`/`step` im Markup sind eine
 * Bequemlichkeit fuer den Browser, keine Pruefung — wer die Anfrage direkt
 * stellt, umgeht sie.
 */
export function EntryScoreForm({
  aktuell,
  modus,
  einsatzMinor,
  capUsd,
  alterMinuten,
  min,
  max,
}: {
  readonly aktuell: number;
  readonly modus: "VORSICHTIG" | "OFFENSIV";
  /** Einsatz je Trade in Cent, oder `null` fuer „Risikobudget". */
  readonly einsatzMinor: bigint | null;
  /** Obergrenze der Marktkapitalisierung in USD. */
  readonly capUsd: bigint;
  /** Hoechstalter in Minuten, oder `null` fuer keine Grenze. */
  readonly alterMinuten: number | null;
  readonly min: number;
  readonly max: number;
}) {
  const [meldung, formAction, laeuft] = useActionState(schwelleSetzen, null);
  const beispiele = [10, 35, 50, 70].filter((n) => n >= min && n <= max);

  return (
    <>
      <h3>Aendern</h3>
      <form action={formAction} className="form form--inline">
        <label className="field">
          <span>
            Schwelle ({min}–{max})
          </span>
          <input
            type="number"
            name="schwelle"
            defaultValue={aktuell}
            min={min}
            max={max}
            step={1}
            required
          />
        </label>
        <label className="field">
          <span>Modus</span>
          <select name="modus" defaultValue={modus}>
            <option value="VORSICHTIG">Vorsichtig — nur mit vollständigen Daten</option>
            <option value="OFFENSIV">Offensiv — entscheidet mit Teildaten</option>
          </select>
        </label>
        <label className="field">
          <span>Einsatz je Trade (EUR)</span>
          <input
            type="text"
            inputMode="decimal"
            name="einsatz"
            defaultValue={einsatzMinor === null ? "" : (Number(einsatzMinor) / 100).toString()}
            placeholder="leer = Risikobudget"
          />
        </label>
        <label className="field">
          <span>Max. Marktkapital (USD)</span>
          <input
            type="text"
            inputMode="numeric"
            name="marktkapital"
            defaultValue={capUsd.toString()}
            placeholder="z. B. 5000000"
          />
        </label>
        <label className="field">
          <span>Max. Alter (Minuten)</span>
          <input
            type="text"
            inputMode="numeric"
            name="alter"
            defaultValue={alterMinuten === null ? "" : String(alterMinuten)}
            placeholder="leer = keine Grenze"
          />
        </label>
        <button type="submit" disabled={laeuft}>
          {laeuft ? "Speichere…" : "Speichern"}
        </button>
      </form>
      <p className="hint">Gaengige Schwellen: {beispiele.join(" · ")}. Jede Zahl dazwischen geht genauso.</p>
      <p className="hint">
        Das Marktkapital-Limit gilt an BEIDEN Stellen: bei der Auswahl, welche Coins
        überhaupt bewertet werden, und am Einstiegstor. Vorher stand es an drei Stellen
        getrennt im Code, und im Offensiv-Modus war es ganz offen — daher die Einstiege in
        große Coins.
      </p>
      <p className="hint">
        Das Höchstalter rechnet an der Entstehungszeit des Handelspaars, die der Anbieter
        mitliefert — nicht an unserem Erstkontakt. Ist sie unbekannt, fällt der Coin bei
        gesetzter Grenze heraus: „ich weiß nicht, wie alt er ist" ist bei „nur neue" kein
        Durchlassgrund. Leer lassen heißt: keine Altersgrenze. Laufende Positionen bleiben
        unberührt, auch wenn ihr Coin älter wird.
      </p>
      <p className="hint">
        Der Einsatz ist eine OBERGRENZE, keine Zusage: es gilt immer der kleinere Wert aus
        Ihrer Vorgabe, der Portfolio-Grenze, der Liquiditaet und dem Barbestand. Welche
        Grenze gebunden hat, steht in der Betriebsdiagnose unter „Passt die
        Positionsgroesse?". Leeres Feld heisst: der Bot rechnet die Groesse wie bisher aus
        dem Risikobudget.
      </p>
      {meldung !== null && (
        <p className="placeholder" role="status">
          <strong>HINWEIS</strong>
          <br />
          {meldung}
        </p>
      )}
    </>
  );
}
