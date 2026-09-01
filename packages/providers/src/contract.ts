import type { z } from "zod";

/**
 * Der Vertrag eines Anbieters als eigener Wert.
 *
 * Das Problem, das dieser Typ loest: ein Adapter ist fertig, aber niemand
 * kennt die Antwortstruktur des Anbieters. Ohne eigenen Typ endet das
 * regelmaessig in einem geratenen Parser mit einem TODO darueber — und ein
 * geratener Parser scheitert nicht beim Schreiben, sondern beim ersten echten
 * Kontakt in der Produktion.
 *
 * Hier ist „Vertrag unbekannt" deshalb ein **Zustand**, kein Kommentar. Ein
 * Adapter mit `unverifiedContract()` ist vollstaendig lauffaehig: er baut die
 * Anfrage, misst die Latenz, klassifiziert den Fehler, schreibt die
 * Provider-Health. Nur produziert er niemals einen Marktwert — die Validierung
 * lehnt jede Antwort mit `SCHEMA_UNVERIFIED` ab.
 *
 * Der Weg zum echten Vertrag ist damit ein Einzeiler: `unverifiedContract()`
 * gegen `zodContract(...)` tauschen. Alles andere bleibt.
 */

export type ContractResult<T> =
  | { readonly kind: "VALID"; readonly value: T }
  /** Antwort kam an, passt aber nicht zum Vertrag. */
  | { readonly kind: "INVALID"; readonly reason: string }
  /**
   * Es gibt keinen geprueften Vertrag.
   *
   * Bewusst verschieden von `INVALID`: dort weicht der Anbieter ab, hier
   * wissen WIR nicht, was richtig waere. Zwei verschiedene Probleme mit zwei
   * verschiedenen Gegenmassnahmen — das eine meldet man dem Anbieter, das
   * andere loest man selbst.
   */
  | { readonly kind: "UNVERIFIED"; readonly reason: string };

export interface ResponseContract<T> {
  /**
   * Version des Vertrags. Wandert in `feature_observations.schema_version`,
   * damit alte Daten interpretierbar bleiben, wenn der Anbieter sein Format
   * aendert.
   */
  readonly schemaVersion: string;
  /** `false`, solange kein Vertrag aus einer Primaerquelle vorliegt. */
  readonly verified: boolean;
  validate(raw: unknown): ContractResult<T>;
}

/**
 * Ein Vertrag, der noch keiner ist.
 *
 * Lehnt jede Antwort ab. Das ist kein Platzhalter, sondern die korrekte
 * Auskunft: solange die Struktur nicht aus einer Primaerquelle bekannt ist,
 * kann niemand sagen, ob eine Antwort richtig interpretiert wurde.
 */
export function unverifiedContract<T>(input: {
  readonly provider: string;
  readonly endpoint: string;
  readonly needed: string;
}): ResponseContract<T> {
  const reason =
    `Kein geprueftes Response-Schema fuer ${input.provider} ${input.endpoint}. ` +
    `Benoetigt: ${input.needed}.`;
  return {
    schemaVersion: "UNVERIFIED",
    verified: false,
    validate: () => ({ kind: "UNVERIFIED", reason }),
  };
}

/**
 * Ein Vertrag aus einem Zod-Schema.
 *
 * `verified` ist ein Pflichtargument und kein Standardwert: wer einen Vertrag
 * anlegt, muss sagen, ob er aus einer Primaerquelle stammt. Ein Schema, das
 * jemand nach bestem Wissen hingeschrieben hat, ist etwas anderes als eines
 * aus einer OpenAPI-Datei — und der Unterschied entscheidet, ob der Anbieter
 * `CAPABILITY_READY` werden darf.
 */
export function zodContract<T>(input: {
  readonly schema: z.ZodType<T>;
  readonly schemaVersion: string;
  readonly verified: boolean;
}): ResponseContract<T> {
  return {
    schemaVersion: input.schemaVersion,
    verified: input.verified,
    validate: (raw: unknown): ContractResult<T> => {
      const parsed = input.schema.safeParse(raw);
      if (parsed.success) return { kind: "VALID", value: parsed.data };
      const first = parsed.error.issues[0];
      const path = first === undefined ? "" : first.path.join(".");
      return {
        kind: "INVALID",
        reason: `${path === "" ? "(Wurzel)" : path}: ${first?.message ?? "unbekannt"}`,
      };
    },
  };
}
