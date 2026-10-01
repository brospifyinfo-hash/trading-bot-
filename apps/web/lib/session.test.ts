import { describe, expect, it } from "vitest";

import {
  SESSION_MAX_AGE_SECONDS,
  issueSession,
  passwordMatches,
  sessionIsValid,
} from "./session";

const SECRET = "x".repeat(40);
const NOW = new Date("2026-10-01T12:00:00Z");

describe("Passwortvergleich", () => {
  it("erkennt das richtige Passwort", () => {
    expect(passwordMatches("ein-langes-geheimnis", "ein-langes-geheimnis")).toBe(true);
  });

  it("weist falsche Passworte ab, auch mit richtigem Anfang", () => {
    expect(passwordMatches("ein-langes-geheimnib", "ein-langes-geheimnis")).toBe(false);
    expect(passwordMatches("", "ein-langes-geheimnis")).toBe(false);
    expect(passwordMatches("ein-langes-geheimnis-und-mehr", "ein-langes-geheimnis")).toBe(false);
  });

  it("laesst ohne gesetztes Passwort NIEMANDEN durch", () => {
    // Die gefaehrlichste denkbare Voreinstellung waere, ein fehlendes Passwort
    // als „offen" zu lesen: dann stuende das Formular bei einer vergessenen
    // Variablen fuer jeden offen, der die Adresse kennt.
    expect(passwordMatches("", undefined)).toBe(false);
    expect(passwordMatches("irgendwas", undefined)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });
});

describe("Sitzungscookie", () => {
  it("stellt ein Cookie aus, das es selbst wieder annimmt", () => {
    const { value, expiresAt } = issueSession(SECRET, NOW);
    expect(sessionIsValid(value, SECRET, NOW)).toBe(true);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(SESSION_MAX_AGE_SECONDS * 1_000);
  });

  it("nimmt ein abgelaufenes Cookie nicht mehr an", () => {
    const { value } = issueSession(SECRET, NOW);
    const spaeter = new Date(NOW.getTime() + (SESSION_MAX_AGE_SECONDS + 1) * 1_000);
    expect(sessionIsValid(value, SECRET, spaeter)).toBe(false);
  });

  it("nimmt kein Cookie an, das mit einem anderen Geheimnis signiert wurde", () => {
    // Das ist zugleich der Weg, alle Anmeldungen zurueckzuziehen: Geheimnis
    // wechseln, und jedes ausgestellte Cookie ist ungueltig.
    const { value } = issueSession("y".repeat(40), NOW);
    expect(sessionIsValid(value, SECRET, NOW)).toBe(false);
  });

  it("laesst sich den Ablauf nicht vom Aufrufer vorschreiben", () => {
    // Der Kern der Signatur: wer den Ablaufzeitpunkt aendert, muss ihn neu
    // signieren koennen — und kann es nicht.
    const { value } = issueSession(SECRET, NOW);
    const [, signatur] = value.split(".");
    const weitInDerZukunft = String(NOW.getTime() + 10 * 365 * 24 * 3_600_000);
    expect(sessionIsValid(`${weitInDerZukunft}.${signatur ?? ""}`, SECRET, NOW)).toBe(false);
  });

  it("weist Unfug als Cookie-Wert ab", () => {
    for (const unfug of [undefined, "", ".", "abc", "abc.def", "1.2.3"]) {
      expect(sessionIsValid(unfug, SECRET, NOW)).toBe(false);
    }
  });
});
