import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Anmeldung mit einem Passwort und einem signierten Cookie.
 *
 * ### Warum ueberhaupt, und warum erst jetzt
 *
 * Diese Oberflaeche war bis hierher reine Anzeige, und ohne Schreibzugriff war
 * fehlende Anmeldung ein hinnehmbarer Zustand. Sobald hier die
 * Einstiegsschwelle gesetzt werden kann, ist es keiner mehr: ein Formular ohne
 * Anmeldung waere ein Schreibzugriff fuer jeden, der die Adresse kennt.
 *
 * ### Warum so klein
 *
 * `lib/auth.ts` beschreibt den Endausbau — Magic Link, TOTP, Step-up fuer
 * kapitalwirksame Handlungen. Der ist hier nicht gebaut, und das ist eine
 * bewusste Entscheidung und keine Abkuerzung: fuer Live-Handel waere er
 * zwingend, und Live-Handel gibt es nicht. Was hier geschuetzt wird, ist EINE
 * Zahl eines Papier-Kontos. Eine halbfertige TOTP-Einfuehrung waere mehr
 * Angriffsflaeche als Schutz.
 *
 * Was dieser Entwurf leistet und was nicht, steht ausgeschrieben, damit es
 * niemand spaeter fuer mehr haelt:
 *
 * - **Ein** Passwort fuer **einen** Betreiber, aus `DASHBOARD_PASSWORD`.
 * - Vergleich in konstanter Zeit, damit die Antwortzeit nichts ueber die
 *   Richtigkeit verraet.
 * - Zustandsloses Cookie: HMAC-SHA256 ueber den Ablaufzeitpunkt, mit
 *   `SESSION_SECRET`. Keine Sitzungstabelle, kein Datenbankzugriff je Aufruf.
 * - Zurueckziehen geht nur ueber einen Wechsel von `SESSION_SECRET`; damit
 *   werden alle ausgestellten Cookies auf einmal ungueltig. Fuer einen
 *   einzelnen Betreiber ist das die passende Grobheit.
 * - KEIN Schutz der Leseansicht. Die war vorher offen und bleibt es; das
 *   hier zu aendern waere eine eigene Entscheidung, die niemand getroffen hat.
 */

/** Name des Cookies. An einer Stelle, damit Setzen und Lesen nicht auseinanderlaufen. */
export const SESSION_COOKIE = "sae_session";

/** Wie lange eine Anmeldung gilt. Kurz genug, dass ein offener Laptop nicht ewig zaehlt. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * Vergleicht zwei Zeichenketten, ohne ueber die Dauer zu verraten, wie weit sie
 * uebereinstimmen.
 *
 * `===` bricht beim ersten abweichenden Zeichen ab. Die Zeitdifferenz ist winzig
 * und ueber viele Versuche trotzdem messbar — damit laesst sich ein Passwort
 * Zeichen fuer Zeichen erraten, statt es als Ganzes raten zu muessen.
 *
 * Gehasht wird vorher, damit beide Seiten gleich lang sind: `timingSafeEqual`
 * wirft bei verschiedenen Laengen, und diese Ausnahme waere selbst wieder ein
 * Signal ueber die Laenge des Passworts.
 */
function gleich(a: string, b: string): boolean {
  const ha = createHmac("sha256", "vergleich").update(a).digest();
  const hb = createHmac("sha256", "vergleich").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function passwordMatches(eingabe: string, erwartet: string | undefined): boolean {
  // Ohne gesetztes Passwort gibt es keine Anmeldung — und ausdruecklich keine
  // Anmeldung, die immer gelingt. Ein leeres erwartetes Passwort als „offen"
  // zu lesen waere die teuerste denkbare Voreinstellung.
  if (erwartet === undefined || erwartet === "") return false;
  return gleich(eingabe, erwartet);
}

/** Der Cookie-Wert: Ablaufzeitpunkt und seine Signatur. */
export function issueSession(secret: string, now: Date): { value: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1_000);
  const ablauf = String(expiresAt.getTime());
  return { value: `${ablauf}.${sign(secret, ablauf)}`, expiresAt };
}

export function sessionIsValid(value: string | undefined, secret: string, now: Date): boolean {
  if (value === undefined) return false;
  const teile = value.split(".");
  if (teile.length !== 2) return false;
  const [ablauf, signatur] = teile;
  if (ablauf === undefined || signatur === undefined) return false;
  // Erst die Signatur, dann der Inhalt: ein unsignierter Ablaufzeitpunkt ist
  // kein Ablaufzeitpunkt, sondern ein Wunsch des Aufrufers.
  if (!gleich(signatur, sign(secret, ablauf))) return false;

  const ende = Number(ablauf);
  if (!Number.isSafeInteger(ende)) return false;
  return ende > now.getTime();
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
