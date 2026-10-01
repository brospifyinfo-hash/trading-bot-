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
  min,
  max,
}: {
  readonly aktuell: number;
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
        <button type="submit" disabled={laeuft}>
          {laeuft ? "Speichere…" : "Speichern"}
        </button>
      </form>
      <p className="hint">Gaengige Werte: {beispiele.join(" · ")}. Jede Zahl dazwischen geht genauso.</p>
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
