"use client";

import { useActionState } from "react";

import { positionVerkaufen } from "@/app/actions";

/**
 * Verkaufen — oder genauer: Verkauf anfordern.
 *
 * Die Beschriftung sagt „verkaufen", der Hinweis darunter sagt, was wirklich
 * passiert. Beides gehoert zusammen: ein Knopf, der „verkauft" verspricht und
 * nur einen Vermerk setzt, waere eine Behauptung ueber einen abgeschlossenen
 * Vorgang. Ein Knopf, der „Vermerk setzen" heisst, waere korrekt und
 * unverstaendlich.
 */
export function SellButton({
  positionId,
  angefordertAm,
}: {
  readonly positionId: string;
  /** Gesetzt, wenn schon angefordert — dann wird zurueckgenommen statt angefordert. */
  readonly angefordertAm: Date | null;
}) {
  const [meldung, formAction, laeuft] = useActionState(positionVerkaufen, null);
  const angefordert = angefordertAm !== null;

  return (
    <form action={formAction} className="sell">
      <input type="hidden" name="positionId" value={positionId} />
      {angefordert && <input type="hidden" name="zuruecknehmen" value="ja" />}
      <button
        type="submit"
        className={angefordert ? "sell__button sell__button--pending" : "sell__button"}
        disabled={laeuft}
        title={
          angefordert
            ? `Verkauf angefordert ${angefordertAm.toISOString()}. Klicken nimmt die Anforderung zurueck.`
            : "Verkauf anfordern. Der Worker fuehrt ihn im naechsten Takt mit echtem Quote aus."
        }
      >
        {laeuft ? "…" : angefordert ? "angefordert · zurücknehmen" : "verkaufen"}
      </button>
      {meldung !== null && (
        <span className="sell__note" role="status">
          {meldung}
        </span>
      )}
    </form>
  );
}
