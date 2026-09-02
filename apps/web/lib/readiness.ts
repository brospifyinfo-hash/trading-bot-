import { webEnvSchema } from "@sae/config";

/**
 * Kann diese Instanz ueberhaupt arbeiten — und wenn nein, woran liegt es?
 *
 * Der Anlass ist ein echter Ausfall: das Dashboard rief `db()` auf, das
 * validierte die Umgebung, warf bei fehlender `DATABASE_URL` — und weil eine
 * Server-Komponente keine Fehlergrenze hatte, endete der ganze Seitenaufruf in
 * Next.js' Sammelmeldung „Application error: a server-side exception has
 * occurred". Diese Meldung sagt dem Betreiber nichts. Sie sagt nicht einmal,
 * dass eine Variable fehlt.
 *
 * Wichtig ist die Unterscheidung, die hier getroffen wird:
 *
 * - **ENV_INCOMPLETE** — die Instanz ist nicht fertig konfiguriert.
 * - **DATABASE_UNREACHABLE** — konfiguriert, aber die Datenbank antwortet nicht.
 * - **READY** — die Datenbank antwortet. Ob dahinter Marktdaten stehen, ist
 *   eine ANDERE Frage, die das Dashboard aus echten Zeilen beantwortet.
 *
 * Diese drei nicht zu vermischen ist der Punkt. „WAITING FOR LIVE MARKET DATA"
 * bei ausgefallener Datenbank anzuzeigen waere bequem und falsch: es behauptet,
 * das System sei bereit und warte nur auf einen Anbieter, waehrend es in
 * Wahrheit nicht einmal lesen kann.
 */

export type WebReadiness =
  | { readonly kind: "READY" }
  /** Namen der fehlenden oder ungueltigen Variablen — niemals ihre Werte. */
  | { readonly kind: "ENV_INCOMPLETE"; readonly problems: readonly EnvProblem[] }
  | { readonly kind: "DATABASE_UNREACHABLE" };

export interface EnvProblem {
  readonly variable: string;
  readonly detail: string;
}

/**
 * Prueft die Umgebung gegen dasselbe Schema, das `db()` benutzt.
 *
 * Gegen das Schema und nicht gegen eine Liste von Namen: eine zweite Liste
 * waere sofort veraltet, sobald jemand das Schema aendert.
 *
 * Ausgegeben werden ausschliesslich Variablennamen und die Regel, die verletzt
 * wurde. Zod-Meldungen enthalten den geprueften Wert nicht — hier wird er
 * zusaetzlich nie angefasst.
 */
export function checkWebEnv(
  // Bewusst ein einfacher Record und nicht `NodeJS.ProcessEnv`: gebraucht wird
  // genau das, was `process.env` strukturell ist. Der engere Typ waere hier nur
  // eine Fessel fuer die Aufrufer, ohne etwas abzusichern.
  env: Readonly<Record<string, string | undefined>> = process.env,
): WebReadiness {
  const result = webEnvSchema.safeParse(env);
  if (result.success) return { kind: "READY" };

  return {
    kind: "ENV_INCOMPLETE",
    problems: result.error.issues.map((issue) => ({
      variable: issue.path.join(".") || "(unbekannt)",
      detail: issue.message,
    })),
  };
}
