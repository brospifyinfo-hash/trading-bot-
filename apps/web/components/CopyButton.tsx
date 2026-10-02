"use client";

import { useState } from "react";

/**
 * Eine Adresse in die Ablage, mit einem Klick.
 *
 * Eine Mint-Adresse ist 32 bis 44 Zeichen Base58 und in der Tabelle noch
 * gekuerzt. Sie von Hand abzuschreiben ist nicht zumutbar, und ein Tippfehler
 * in einer Adresse fuehrt nicht zu einer Fehlermeldung, sondern zu einem
 * anderen Token.
 *
 * `navigator.clipboard` braucht einen sicheren Kontext (HTTPS) und kann
 * verweigert werden. Beides wird abgefangen: schlaegt es fehl, erscheint die
 * Adresse zum Markieren, statt dass der Knopf nur stumm nichts tut.
 */
export function CopyButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label?: string;
}) {
  const [zustand, setZustand] = useState<"BEREIT" | "KOPIERT" | "FEHLER">("BEREIT");

  const kopieren = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setZustand("KOPIERT");
      window.setTimeout(() => setZustand("BEREIT"), 1_500);
    } catch {
      setZustand("FEHLER");
    }
  };

  return (
    <span className="copy">
      <button
        type="button"
        className="copy__button"
        onClick={() => void kopieren()}
        title={`${label ?? "Adresse"} kopieren: ${value}`}
        aria-label={`${label ?? "Adresse"} kopieren`}
      >
        {zustand === "KOPIERT" ? "kopiert" : "kopieren"}
      </button>
      {zustand === "FEHLER" && (
        <input
          className="copy__fallback"
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={`${label ?? "Adresse"} zum Markieren`}
        />
      )}
    </span>
  );
}
