"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { ENTRY_SCORE_MAX, ENTRY_SCORE_MIN, isValidEntryScore, saveEntryScore } from "@sae/db";

import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  issueSession,
  passwordMatches,
  sessionIsValid,
} from "@/lib/session";

/**
 * Die schreibenden Handlungen der Oberflaeche.
 *
 * Es sind genau drei, und das ist Absicht: anmelden, abmelden, Schwelle
 * setzen. Jede weitere Schreibmoeglichkeit waere eine eigene Entscheidung.
 *
 * Alle drei pruefen ihre Voraussetzungen SERVERSEITIG. Ein Formular, das nur
 * dann angezeigt wird, wenn man angemeldet ist, ist keine Pruefung — es ist
 * eine Anzeigeentscheidung, und wer die Anfrage direkt stellt, umgeht sie.
 */

export async function sitzungAktiv(): Promise<boolean> {
  const secret = process.env["SESSION_SECRET"];
  if (secret === undefined) return false;
  const laden = await cookies();
  return sessionIsValid(laden.get(SESSION_COOKIE)?.value, secret, new Date());
}

/** Ist ueberhaupt ein Passwort hinterlegt? Fuer die Auskunft in der Anzeige. */
export async function anmeldungMoeglich(): Promise<boolean> {
  return process.env["DASHBOARD_PASSWORD"] !== undefined;
}

export async function anmelden(_zustand: string | null, formData: FormData): Promise<string> {
  const secret = process.env["SESSION_SECRET"];
  if (secret === undefined) return "Diese Instanz ist nicht fertig konfiguriert.";

  const erwartet = process.env["DASHBOARD_PASSWORD"];
  if (erwartet === undefined) {
    return "Es ist kein Passwort hinterlegt. Ohne DASHBOARD_PASSWORD gibt es keine Anmeldung.";
  }

  const eingabe = formData.get("passwort");
  // Eine fehlende Eingabe wird wie eine falsche behandelt und nicht
  // unterschieden: jede Unterscheidung an dieser Stelle ist eine Auskunft an
  // jemanden, der sie nicht bekommen soll.
  if (!passwordMatches(typeof eingabe === "string" ? eingabe : "", erwartet)) {
    return "Passwort falsch.";
  }

  const { value, expiresAt } = issueSession(secret, new Date());
  const laden = await cookies();
  laden.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  redirect("/");
}

export async function abmelden(): Promise<void> {
  const laden = await cookies();
  laden.delete(SESSION_COOKIE);
  redirect("/");
}

export async function schwelleSetzen(
  _zustand: string | null,
  formData: FormData,
): Promise<string> {
  // Serverseitig, nicht „das Formular war ja nicht sichtbar".
  if (!(await sitzungAktiv())) return "Nicht angemeldet.";

  const roh = formData.get("schwelle");
  const wert = typeof roh === "string" ? Number(roh.trim()) : Number.NaN;
  if (!isValidEntryScore(wert)) {
    return `Bitte eine ganze Zahl zwischen ${String(ENTRY_SCORE_MIN)} und ${String(ENTRY_SCORE_MAX)} angeben.`;
  }

  await saveEntryScore(db(), { score: wert, actor: "dashboard", at: new Date() });
  // Die Seite liest die Datenbank bei jedem Aufruf; ohne diese Zeile zeigte
  // der naechste Aufruf trotzdem die zwischengespeicherte alte Zahl.
  revalidatePath("/");
  return `Gespeichert: ${String(wert)}. Der Worker rechnet ab dem naechsten Lauf damit.`;
}
