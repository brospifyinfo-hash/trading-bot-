"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import {
  ENTRY_SCORE_MAX,
  ENTRY_SCORE_MIN,
  isPaperMode,
  isValidEntryNotional,
  isValidEntryScore,
  isValidMaxCoinAge,
  isValidMaxMarketCap,
  MAX_MARKET_CAP_CEILING,
  ENTRY_NOTIONAL_MAX_MINOR,
  MAX_COPY_WALLETS,
  addCopyWallets,
  cancelPositionClose,
  isValidWalletAddress,
  parseWalletList,
  removeCopyWallet,
  requestPositionClose,
  saveEntryScore,
  setCopyWalletActive,
} from "@sae/db";

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
 * Jede einzelne ist eine eigene Entscheidung gewesen: anmelden, abmelden,
 * Schwelle setzen, Position verkaufen, Vorbild-Wallets pflegen. Die Liste
 * waechst nicht aus Bequemlichkeit — eine Schreibmoeglichkeit mehr ist eine
 * Angriffsflaeche mehr, und sie steht ohne Passwort offen, wenn der Betreiber
 * das so eingestellt hat.
 *
 * Alle pruefen ihre Voraussetzungen SERVERSEITIG. Ein Formular, das nur
 * dann angezeigt wird, wenn man angemeldet ist, ist keine Pruefung — es ist
 * eine Anzeigeentscheidung, und wer die Anfrage direkt stellt, umgeht sie.
 */

export async function sitzungAktiv(): Promise<boolean> {
  const secret = process.env["SESSION_SECRET"];
  if (secret === undefined) return false;
  const laden = await cookies();
  return sessionIsValid(laden.get(SESSION_COOKIE)?.value, secret, new Date());
}

/**
 * Ist ein Passwort hinterlegt — und damit die Anmeldung verlangt?
 *
 * Das ist der SCHALTER zwischen den beiden Betriebsarten, und er ist bewusst
 * genau eine Variable:
 *
 * - **Nicht gesetzt** — die Einstellung steht offen. Jeder, der die Adresse
 *   kennt, kann die Schwelle aendern. Das ist eine Entscheidung des
 *   Betreibers, und sie steht in der Anzeige ausgeschrieben, damit sie
 *   niemanden spaeter ueberrascht.
 * - **Gesetzt** — ohne Anmeldung geht nichts. Umschalten verlangt keine
 *   Codeaenderung und kein Deployment von jemand anderem: Variable setzen,
 *   fertig.
 *
 * Tragbar ist das offene Verhalten, weil es Papierhandel ist: kein Kapital,
 * keine Wallet-Operation, keine Live-Freigabe. Aenderbar ist genau eine Zahl
 * mit festen Grenzen, und jede Aenderung steht in `system_events`.
 */
export async function schutzAktiv(): Promise<boolean> {
  return process.env["DASHBOARD_PASSWORD"] !== undefined;
}

/** Darf hier gerade geaendert werden? Offen, oder angemeldet. */
export async function darfAendern(): Promise<boolean> {
  if (!(await schutzAktiv())) return true;
  return sitzungAktiv();
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
  // Serverseitig, nicht „das Formular war ja nicht sichtbar". Ohne gesetztes
  // Passwort ist das offen — mit gesetztem ist es die einzige Pruefung, die
  // zaehlt.
  if (!(await darfAendern())) return "Nicht angemeldet.";

  const roh = formData.get("schwelle");
  const wert = typeof roh === "string" ? Number(roh.trim()) : Number.NaN;
  if (!isValidEntryScore(wert)) {
    return `Bitte eine ganze Zahl zwischen ${String(ENTRY_SCORE_MIN)} und ${String(ENTRY_SCORE_MAX)} angeben.`;
  }

  // Ein unbekannter Modus wird abgewiesen und NICHT als „offensiv" gelesen.
  const modusRoh = formData.get("modus");
  if (modusRoh !== null && !isPaperMode(modusRoh)) {
    return "Unbekannter Modus.";
  }
  const modus = isPaperMode(modusRoh) ? modusRoh : undefined;

  /*
   * Der Einsatz je Trade, in Euro eingegeben und in Cent gespeichert.
   *
   * Die Umrechnung laeuft ueber Zeichenketten und nicht ueber `* 100`: 19.99
   * mal 100 ergibt in Gleitkomma 1998.9999999999998, und Geld wird in diesem
   * System nie als Gleitkommazahl gefuehrt.
   *
   * Leeres Feld heisst „keine Vorgabe" und damit Risikobudget — das ist eine
   * ausdrueckliche Wahl und kein fehlender Wert.
   */
  const einsatzRoh = formData.get("einsatz");
  let einsatzMinor: bigint | null | undefined;
  if (typeof einsatzRoh === "string") {
    const geputzt = einsatzRoh.trim().replace(",", ".");
    if (geputzt === "") {
      einsatzMinor = null;
    } else {
      const treffer = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(geputzt);
      if (treffer === null) {
        return "Einsatz je Trade: bitte einen Betrag wie 25 oder 12,50 angeben.";
      }
      const cent = BigInt(treffer[1] ?? "0") * 100n + BigInt((treffer[2] ?? "").padEnd(2, "0"));
      if (!isValidEntryNotional(cent)) {
        return `Einsatz je Trade muss groesser als 0 und hoechstens ${String(ENTRY_NOTIONAL_MAX_MINOR / 100n)} Euro sein.`;
      }
      einsatzMinor = cent;
    }
  }

  /*
   * Die Groessengrenze, in USD. Ganze Dollar genuegen — ein Marktkapital auf
   * den Cent genau zu begrenzen beschreibt eine Genauigkeit, die die
   * Anbieterzahlen nicht haben.
   */
  const capRoh = formData.get("marktkapital");
  let capUsd: bigint | undefined;
  if (typeof capRoh === "string" && capRoh.trim() !== "") {
    const geputzt = capRoh.trim().replace(/[._\s]/g, "");
    if (!/^\d{1,13}$/.test(geputzt)) {
      return "Groessengrenze: bitte eine ganze Zahl in USD angeben, zum Beispiel 5000000.";
    }
    const wert = BigInt(geputzt);
    if (!isValidMaxMarketCap(wert)) {
      return `Groessengrenze muss groesser als 0 und hoechstens ${String(MAX_MARKET_CAP_CEILING)} USD sein.`;
    }
    capUsd = wert;
  }

  /*
   * Das Hoechstalter in Minuten. Leer heisst ausdruecklich „keine Grenze" und
   * nicht „0 Minuten" — das waere ein leerer Suchraum.
   */
  const alterRoh = formData.get("alter");
  let alterMinuten: number | null | undefined;
  if (typeof alterRoh === "string") {
    const geputzt = alterRoh.trim();
    if (geputzt === "") {
      alterMinuten = null;
    } else if (!/^\d{1,6}$/.test(geputzt) || !isValidMaxCoinAge(Number(geputzt))) {
      return "Hoechstalter: bitte eine ganze Zahl Minuten angeben, oder leer lassen fuer keine Grenze.";
    } else {
      alterMinuten = Number(geputzt);
    }
  }

  // Wer es war, so genau wie es ehrlich geht. Ohne Anmeldung ist „jemand ueber
  // das Dashboard" die ganze Wahrheit, und sie gehoert so in die
  // Aenderungsspur — ein schlichtes „dashboard" liesse spaeter glauben, es sei
  // belegt, wer gedreht hat.
  const actor = (await schutzAktiv()) ? "dashboard (angemeldet)" : "dashboard (offen)";
  try {
    await saveEntryScore(db(), {
      score: wert,
      actor,
      at: new Date(),
      ...(modus === undefined ? {} : { mode: modus }),
      ...(einsatzMinor === undefined ? {} : { entryNotionalMinor: einsatzMinor }),
      ...(capUsd === undefined ? {} : { maxMarketCapUsd: capUsd }),
      ...(alterMinuten === undefined ? {} : { maxCoinAgeMinutes: alterMinuten }),
    });
  } catch (error: unknown) {
    // Die Obergrenze je Minute meldet sich hier. Sie als technischen Fehler
    // durchzureichen hiesse, dem Betreiber eine Sammelmeldung zu zeigen, wo
    // eine Erklaerung gehoert.
    return error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
  }
  // Die Seite liest die Datenbank bei jedem Aufruf; ohne diese Zeile zeigte
  // der naechste Aufruf trotzdem die zwischengespeicherte alte Zahl.
  revalidatePath("/");
  const einsatzText =
    einsatzMinor === undefined
      ? ""
      : einsatzMinor === null
        ? ", Einsatz nach Risikobudget"
        : `, Einsatz ${(Number(einsatzMinor) / 100).toLocaleString("de-DE")} EUR`;
  const capText = capUsd === undefined
    ? ""
    : `, Groessengrenze ${Number(capUsd).toLocaleString("de-DE")} USD`;
  const alterText = alterMinuten === undefined
    ? ""
    : alterMinuten === null
      ? ", kein Hoechstalter"
      : `, Hoechstalter ${String(alterMinuten)} min`;
  return `Gespeichert: Schwelle ${String(wert)}${modus === undefined ? "" : `, Modus ${modus}`}${einsatzText}${capText}${alterText}. Der Worker rechnet ab dem naechsten Lauf damit.`;
}

/**
 * Verkauf einer offenen Position anfordern.
 *
 * Es wird NICHT hier verkauft. Diese Oberflaeche laeuft auf einer anderen
 * Maschine als der Worker, hat keinen Router-Zugang und muesste einen
 * Ausstiegskurs erfinden, um selbst zu schliessen — und ein erfundener
 * Ausstiegskurs macht die Papier-Statistik ab diesem Trade wertlos.
 *
 * Also wird ein Vermerk gesetzt. Der Positions-Monitor fuehrt ihn im naechsten
 * Takt aus, mit echtem Quote und echter Bewertung, durch genau denselben Pfad
 * wie ein Stop Loss. Bleibt ein ausfuehrbares Quote aus, bleibt der Vermerk
 * stehen und wird beim naechsten Takt erneut versucht.
 */
export async function positionVerkaufen(
  _zustand: string | null,
  formData: FormData,
): Promise<string> {
  if (!(await darfAendern())) return "Nicht angemeldet.";

  const id = formData.get("positionId");
  // Eine UUID und sonst nichts. Der Wert kommt aus einem Formular.
  if (typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return "Unbekannte Position.";
  }
  const zuruecknehmen = formData.get("zuruecknehmen") === "ja";

  const ergebnis = zuruecknehmen
    ? await cancelPositionClose(db(), { positionId: id, actor: "dashboard", at: new Date() })
    : await requestPositionClose(db(), { positionId: id, actor: "dashboard", at: new Date() });
  revalidatePath("/");

  if (ergebnis.kind === "NOT_OPEN") {
    return zuruecknehmen
      ? "Es lag keine Anforderung vor, die sich zuruecknehmen liesse."
      : "Diese Position ist nicht mehr offen.";
  }
  if (ergebnis.kind === "ALREADY_REQUESTED") {
    return `Verkauf war schon angefordert (${ergebnis.at.toISOString()}). Der Worker fuehrt ihn aus, sobald ein ausfuehrbares Quote vorliegt.`;
  }
  return zuruecknehmen
    ? "Anforderung zurueckgenommen. Die Position bleibt offen."
    : "Verkauf angefordert. Der Worker fuehrt ihn im naechsten Takt aus — mit echtem Quote, nicht mit einem geschaetzten Kurs.";
}

/**
 * Wallets hinzufuegen, deren Trades kopiert werden sollen.
 *
 * Eine Eingabe, viele Adressen. Was nicht lesbar war, wird GEMELDET und nicht
 * verschluckt: eine Adresse mit einem Tippfehler liegt sonst still in der
 * Liste und sieht monatelang aus wie eine Wallet, die einfach nicht handelt.
 */
export async function walletsHinzufuegen(
  _zustand: string | null,
  formData: FormData,
): Promise<string> {
  if (!(await darfAendern())) return "Nicht angemeldet.";

  const eingabe = formData.get("adressen");
  if (typeof eingabe !== "string" || eingabe.trim().length === 0) {
    return "Keine Adresse eingegeben.";
  }
  if (eingabe.length > 20_000) {
    return "Die Eingabe ist zu lang. Bitte in kleineren Blocken einfuegen.";
  }

  const gelesen = parseWalletList(eingabe);
  if (gelesen.gueltig.length === 0) {
    return gelesen.ungueltig.length === 0
      ? "Keine Adresse erkannt."
      : `Keine gueltige Adresse erkannt. Nicht lesbar: ${gelesen.ungueltig.slice(0, 5).join(", ")}`;
  }

  const ergebnis = await addCopyWallets(db(), gelesen.gueltig, "dashboard");
  revalidatePath("/");

  const teile: string[] = [];
  if (ergebnis.angelegt.length > 0) {
    teile.push(`${String(ergebnis.angelegt.length)} hinzugefuegt`);
  }
  if (ergebnis.bekannt.length > 0) {
    teile.push(`${String(ergebnis.bekannt.length)} waren schon drin`);
  }
  if (gelesen.doppelt.length > 0) {
    teile.push(`${String(gelesen.doppelt.length)} doppelt in der Eingabe`);
  }
  if (gelesen.ungueltig.length > 0) {
    teile.push(
      `nicht lesbar: ${gelesen.ungueltig.slice(0, 5).join(", ")}${gelesen.ungueltig.length > 5 ? " …" : ""}`,
    );
  }
  if (ergebnis.kind === "LIMIT_REACHED") {
    teile.push(
      `${String(ergebnis.abgewiesen.length)} nicht mehr aufgenommen — die Liste ist bei ${String(MAX_COPY_WALLETS)} voll`,
    );
  }
  return `${teile.join(" · ")}.`;
}

/** Kopieren von einer Wallet anhalten oder wieder aufnehmen. */
export async function walletSchalten(
  _zustand: string | null,
  formData: FormData,
): Promise<string> {
  if (!(await darfAendern())) return "Nicht angemeldet.";

  const adresse = formData.get("adresse");
  if (!isValidWalletAddress(adresse)) return "Unbekannte Adresse.";
  const einschalten = formData.get("aktiv") === "ja";

  const ok = await setCopyWalletActive(db(), adresse, einschalten);
  revalidatePath("/");
  if (!ok) return "Diese Wallet steht nicht in der Liste.";
  return einschalten
    ? "Kopieren wieder aufgenommen. Gelesen wird ab jetzt, nicht rueckwirkend."
    : "Kopieren angehalten. Laufende Positionen bleiben offen — sie schliesst der Bot nach seinen Ausstiegsregeln oder Sie von Hand.";
}

/** Eine Wallet aus der Liste nehmen. Nur, wenn nie von ihr kopiert wurde. */
export async function walletEntfernen(
  _zustand: string | null,
  formData: FormData,
): Promise<string> {
  if (!(await darfAendern())) return "Nicht angemeldet.";

  const adresse = formData.get("adresse");
  if (!isValidWalletAddress(adresse)) return "Unbekannte Adresse.";

  const ergebnis = await removeCopyWallet(db(), adresse);
  revalidatePath("/");
  if (ergebnis === "ENTFERNT") return "Wallet entfernt.";
  if (ergebnis === "NICHT_GEFUNDEN") return "Diese Wallet steht nicht in der Liste.";
  return (
    "Von dieser Wallet wurde schon kopiert — sie bleibt deshalb in der Liste. " +
    "Sonst waere nicht mehr nachvollziehbar, woher die Trades kamen. " +
    "Zum Aufhoeren genuegt „Anhalten“."
  );
}
