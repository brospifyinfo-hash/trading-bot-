/**
 * Zugangsdaten aus einem Fehlertext entfernen, bevor er angezeigt wird.
 *
 * `job_queue.last_error` ist Freitext aus einer Ausnahme. Eine
 * Postgres-Fehlermeldung enthaelt die Verbindungszeichenfolge samt Passwort,
 * und diese Seite laeuft auf Wunsch des Betreibers ohne Anmeldung — jeder, der
 * die Adresse kennt, liest mit.
 *
 * ### Warum nicht einfach verstecken
 *
 * Das war mein erster Versuch, und er war falsch. Hinter die Anmeldung
 * geschoben heisst bei NICHT gesetztem Passwort „fuer alle offen" und bei
 * gesetztem „fuer den Betreiber unsichtbar" — ausgerechnet dann, wenn er den
 * Text zum Debuggen braucht. 6688 gescheiterte Auftraege ohne lesbare Ursache
 * sind genau die Lage, in der dieses Projekt seit Wochen festhaengt.
 *
 * ### Warum das hier eine Abschwaechung ist und keine Garantie
 *
 * Die Logredaktion dieses Projekts arbeitet mit einer ERLAUBNISLISTE
 * (`packages/observability/src/redaction.ts`), und das ist der richtige
 * Ansatz: was nicht ausdruecklich erlaubt ist, faellt weg. Fuer einen
 * Freitext gibt es keine Erlaubnisliste — es gibt keine Liste zulaessiger
 * Fehlermeldungen. Hier bleibt nur eine Verbotsliste, und eine Verbotsliste
 * kennt nur, was man ihr beigebracht hat.
 *
 * Deshalb steht in der Oberflaeche ausdruecklich, dass der Text BEREINIGT ist
 * und nicht, dass er sauber ist. Eine Zusicherung, die ich nicht halten kann,
 * waere schlimmer als der Hinweis auf die Luecke.
 */

/** Obergrenze. Ein Stacktrace ueber zwanzig Zeilen hilft in einer Liste niemandem. */
const MAX_LAENGE = 400;

const MUSTER: readonly (readonly [RegExp, string])[] = [
  // Zugangsdaten in einer URL: postgres://nutzer:passwort@host/db
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[zugangsdaten entfernt]@"],
  // Benannte Geheimnisse als Schluessel=Wert, in Query-Strings, Kopfzeilen
  // und JSON. Drei Feinheiten, die der Test je einzeln aufgedeckt hat:
  //
  // - Der Schluessel darf VORSILBEN tragen (`DB_PASSWORD`, `X-API-KEY`).
  //   Mit `\b` davor griff das Muster bei `DB_PASSWORD` nicht, weil `_` ein
  //   Wortzeichen ist und es dort gar keine Wortgrenze gibt.
  // - Der Anfuehrungsstrich wird mitgefangen und hinten wieder verlangt,
  //   sonst scheitert `apiKey: 'wert'` am Strich vor dem Wert.
  // - Ein Schema-Wort wie `Bearer` wird uebersprungen, sonst gilt es als der
  //   Wert und das eigentliche Geheimnis bleibt stehen.
  [
    /([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|auth|bearer|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?(["']?)[^\s,;&"'})\]]{1,200}\2/gi,
    "$1=[entfernt]",
  ],
  // Was wie ein JWT aussieht.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt entfernt]"],
  // Lange zusammenhaengende Hex-Ketten: Schluessel, nicht Adressen.
  [/\b[0-9a-f]{48,}\b/gi, "[hex entfernt]"],
];

/**
 * `null`, wenn nichts anzuzeigen ist. Sonst der bereinigte, gekuerzte Text.
 *
 * Steuerzeichen fallen weg: der Wert landet in HTML, und auch wenn React
 * selbst escapet, gehoert ein `\r` nicht in eine Listenzeile.
 */
export function scrubFehlertext(text: string | null): string | null {
  if (text === null) return null;
  let out = text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  if (out.length === 0) return null;
  for (const [muster, ersatz] of MUSTER) out = out.replace(muster, ersatz);
  return out.length > MAX_LAENGE ? `${out.slice(0, MAX_LAENGE)} …` : out;
}
