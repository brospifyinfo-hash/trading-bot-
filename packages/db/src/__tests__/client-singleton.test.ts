import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, getDatabase, resetDatabaseCache, SERVERLESS_DB_OPTIONS } from "../client";

/**
 * Eine Verbindung je Prozess, nicht je Anfrage.
 *
 * Der Fehler, den dieser Test festhaelt: `createDatabase()` im Request-Handler
 * legt bei jeder Anfrage einen neuen Pool an. Auf einer Plattform, auf der eine
 * Instanz viele Anfragen bedient, ist das der direkte Weg in „too many
 * connections" — und zwar unter Last.
 *
 * Es wird keine Verbindung aufgebaut: `postgres()` verbindet sich erst bei der
 * ersten Abfrage. Geprueft wird die Identitaet der Objekte.
 */

const URL_A = "postgres://user:pw@localhost:5432/a";
const URL_B = "postgres://user:pw@localhost:5432/b";

afterEach(() => {
  resetDatabaseCache();
});

describe("Vercel-tauglicher Verbindungscache", () => {
  it("gibt fuer dieselbe Verbindung dasselbe Objekt zurueck", () => {
    const first = getDatabase(URL_A, SERVERLESS_DB_OPTIONS);
    const second = getDatabase(URL_A, SERVERLESS_DB_OPTIONS);
    expect(second).toBe(first);
  });

  it("trennt verschiedene Datenbanken", () => {
    expect(getDatabase(URL_A)).not.toBe(getDatabase(URL_B));
  });

  it("trennt lesenden und schreibenden Zugriff", () => {
    // Zwei Pools mit verschiedenen Grenzen duerfen sich nicht gegenseitig
    // ueberschreiben.
    const readOnly = getDatabase(URL_A, { ...SERVERLESS_DB_OPTIONS, readonly: true });
    const writable = getDatabase(URL_A, { ...SERVERLESS_DB_OPTIONS, readonly: false });
    expect(readOnly).not.toBe(writable);
  });

  it("trennt verschiedene Poolgroessen", () => {
    expect(getDatabase(URL_A, { maxConnections: 1 })).not.toBe(
      getDatabase(URL_A, { maxConnections: 10 }),
    );
  });

  it("legt nach einem Cold Start neu an", () => {
    const before = getDatabase(URL_A);
    resetDatabaseCache();
    expect(getDatabase(URL_A)).not.toBe(before);
  });

  it("erzeugt mit createDatabase weiterhin jedes Mal einen eigenen Pool", () => {
    // Der Worker will das so: ein langlebiger Prozess mit einem eigenen Pool.
    expect(createDatabase(URL_A)).not.toBe(createDatabase(URL_A));
  });

  it("haelt die Serverless-Voreinstellung klein", () => {
    // Beliebig viele Instanzen mal zehn Verbindungen sind zu viele.
    expect(SERVERLESS_DB_OPTIONS.maxConnections).toBe(1);
  });
});
