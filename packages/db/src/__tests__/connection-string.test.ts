import { describe, expect, it } from "vitest";

import { sanitizeConnectionString } from "../client";

/**
 * Der Parameter, der die Verbindung zu Neon verhindert hat.
 *
 * `postgres-js` sammelt alle Query-Parameter der URL ein, behandelt die ihm
 * bekannten und reicht **alle uebrigen** als Startup-Parameter an den Server
 * weiter. PostgreSQL antwortet auf `channel_binding` dann mit
 * `unrecognized configuration parameter` — die Verbindung kommt gar nicht erst
 * zustande.
 *
 * Neon haengt genau diesen Parameter standardmaessig an seine
 * Verbindungszeichenfolgen an. Ihn nur in der Plattform wegzuloeschen reicht
 * nicht: die Neon-Vercel-Integration traegt ihn bei der naechsten
 * Provisionierung wieder ein.
 */

const NEON_STYLE =
  "postgresql://user:pw@ep-beispiel.eu-central-1.aws.neon.tech/neondb" +
  "?sslmode=require&channel_binding=require";

describe("Was entfernt wird", () => {
  it("entfernt channel_binding", () => {
    const out = sanitizeConnectionString(NEON_STYLE);
    expect(out).not.toContain("channel_binding");
  });

  it("behaelt sslmode — die Verbindung bleibt verschluesselt", () => {
    // Der wichtigste Test der Datei: das Entfernen darf die Verbindung nicht
    // unverschluesselt machen. `sslmode` versteht postgres-js selbst.
    expect(sanitizeConnectionString(NEON_STYLE)).toContain("sslmode=require");
  });

  it("laesst Host, Benutzer, Passwort und Datenbank unangetastet", () => {
    const out = sanitizeConnectionString(NEON_STYLE);
    expect(out).toContain("user:pw@ep-beispiel.eu-central-1.aws.neon.tech");
    expect(out).toContain("/neondb");
  });

  it("entfernt auch die uebrigen libpq-Client-Optionen", () => {
    const out = sanitizeConnectionString(
      "postgres://u@h:5432/d?gssencmode=disable&sslcert=/x&sslkey=/y&passfile=/z",
    );
    for (const name of ["gssencmode", "sslcert", "sslkey", "passfile"]) {
      expect(out).not.toContain(name);
    }
  });
});

describe("Was unveraendert bleibt", () => {
  it("laesst eine Zeichenfolge ohne Parameter voellig unberuehrt", () => {
    const url = "postgres://sae@127.0.0.1:5432/sae";
    expect(sanitizeConnectionString(url)).toBe(url);
  });

  it("laesst eine Zeichenfolge ohne betroffene Parameter unberuehrt", () => {
    // Identitaet, nicht nur Gleichwertigkeit: ohne Treffer wird die
    // urspruengliche Zeichenfolge zurueckgegeben und nicht neu zusammengesetzt.
    const url = "postgres://sae@127.0.0.1:5432/sae?sslmode=require";
    expect(sanitizeConnectionString(url)).toBe(url);
  });

  it("gibt eine unparsbare Zeichenfolge unveraendert zurueck", () => {
    // Eine kaputte URL soll ihren eigenen Fehler zeigen und nicht einen neuen
    // aus dieser Funktion.
    expect(sanitizeConnectionString("kein-url")).toBe("kein-url");
  });

  it("laesst ein Passwort mit Sonderzeichen unveraendert", () => {
    // `URL.toString()` wuerde das Passwort neu kodieren und damit eine
    // funktionierende Verbindung zerstoeren koennen. Deshalb wird nur der
    // Query-Teil ersetzt.
    const url = "postgres://u:p%40ss%2Fword@h:5432/d?channel_binding=require";
    const out = sanitizeConnectionString(url);
    expect(out).toContain("u:p%40ss%2Fword@h:5432/d");
    expect(out).not.toContain("channel_binding");
  });

  it("laesst nur den Rumpf uebrig, wenn alle Parameter entfallen", () => {
    expect(sanitizeConnectionString("postgres://u@h:5432/d?channel_binding=require")).toBe(
      "postgres://u@h:5432/d",
    );
  });
});
