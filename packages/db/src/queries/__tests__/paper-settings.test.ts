import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../testing/harness";
import type { Database } from "../../client";
import { systemEvents } from "../../schema/ops";
import { paperSettings } from "../../schema/settings";
import {
  ENTRY_SCORE_DEFAULT,
  ENTRY_SCORE_MAX_CHANGES_PER_MINUTE,
  ENTRY_SCORE_MAX,
  ENTRY_SCORE_MIN,
  isValidEntryScore,
  loadEntryScore,
  saveEntryScore,
  seedEntryScoreFromEnv,
} from "../paper-settings";

/**
 * Die eine Einstellung, die der Betreiber selbst setzt.
 *
 * Sie lebt in der Datenbank, weil Dashboard und Worker auf verschiedenen
 * Maschinen laufen. Was hier gepruft wird, sind die drei Stellen, an denen
 * eine solche Einstellung still falsch werden kann: eine Voreinstellung, die
 * wie eine Wahl aussieht; ein Wert ausserhalb der Grenzen; und ein Umzug, der
 * eine frueher getroffene Wahl verschluckt.
 */
let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

describe("Einstiegsschwelle in der Datenbank", () => {
  it("meldet die Voreinstellung als Voreinstellung, nicht als Wahl", async () => {
    const gelesen = await loadEntryScore(db);
    expect(gelesen.score).toBe(ENTRY_SCORE_DEFAULT);
    expect(gelesen.source).toBe("DEFAULT");
    expect(gelesen.updatedAt).toBeNull();
  });

  it("speichert, liest zurueck und haelt die Aenderung fest", async () => {
    const at = new Date("2026-10-01T12:00:00Z");
    await saveEntryScore(db, { score: 35, actor: "dashboard", at });

    const gelesen = await loadEntryScore(db);
    expect(gelesen).toEqual({ score: 35, source: "SAVED", updatedAt: at, updatedBy: "dashboard" });

    // Ohne Aenderungsspur waere spaeter nicht beantwortbar, warum an einem Tag
    // ploetzlich zwanzig Positionen entstanden sind.
    const ereignisse = await db.select().from(systemEvents);
    const aenderung = ereignisse.find((e) => e.kind === "ENTRY_SCORE_CHANGED");
    expect(aenderung?.detail).toMatchObject({ von: null, nach: 35, durch: "dashboard" });
  });

  it("ueberschreibt statt eine zweite Zeile anzulegen", async () => {
    const at = new Date("2026-10-01T13:00:00Z");
    await saveEntryScore(db, { score: 70, actor: "dashboard", at });

    const zeilen = await db.select().from(paperSettings);
    expect(zeilen).toHaveLength(1);
    expect((await loadEntryScore(db)).score).toBe(70);

    const ereignisse = await db.select().from(systemEvents);
    expect(ereignisse.filter((e) => e.kind === "ENTRY_SCORE_CHANGED")).toHaveLength(2);
    expect(ereignisse.find((e) => (e.detail as { nach?: number }).nach === 70)?.detail)
      .toMatchObject({ von: 35, nach: 70 });
  });

  it.each([9, 96, 0, -5, 50.5, Number.NaN])("weist %s als Schwelle ab", async (wert) => {
    await expect(saveEntryScore(db, { score: wert, actor: "test", at: new Date() }))
      .rejects.toThrow();
    // Und der abgewiesene Versuch hat nichts veraendert.
    expect((await loadEntryScore(db)).score).toBe(70);
  });

  it("kennt seine Grenzen", () => {
    expect(isValidEntryScore(ENTRY_SCORE_MIN)).toBe(true);
    expect(isValidEntryScore(ENTRY_SCORE_MAX)).toBe(true);
    expect(isValidEntryScore(ENTRY_SCORE_MIN - 1)).toBe(false);
    expect(isValidEntryScore(ENTRY_SCORE_MAX + 1)).toBe(false);
    expect(isValidEntryScore("50")).toBe(false);
  });
});

/**
 * Die Obergrenze, die ein offener Schreibweg braucht.
 *
 * Die Einstellung laesst sich ohne Anmeldung setzen — eine Entscheidung des
 * Betreibers, und bei Papierhandel vertretbar. Offen heisst aber nicht
 * schutzlos: ohne Obergrenze waere dieser Weg eine Moeglichkeit, die Datenbank
 * mit Aenderungseintraegen vollzuschreiben.
 *
 * Geprueft wird in `saveEntryScore` und nicht in der Oberflaeche. Eine
 * Pruefung im Formular ist keine Pruefung — wer die Anfrage direkt stellt,
 * umgeht sie.
 */
describe("Obergrenze fuer Aenderungen", () => {
  it("nimmt nach zu vielen Aenderungen je Minute nichts mehr an", async () => {
    const { db: eigen, close: schliessen } = await createTestDatabase();
    try {
      const at = new Date("2026-10-01T15:00:00Z");
      for (let i = 0; i < ENTRY_SCORE_MAX_CHANGES_PER_MINUTE; i += 1) {
        await saveEntryScore(eigen, { score: 20 + i, actor: "test", at });
      }
      await expect(saveEntryScore(eigen, { score: 60, actor: "test", at }))
        .rejects.toThrow(/zu viele/i);

      // Der abgewiesene Versuch hat nichts veraendert.
      expect((await loadEntryScore(eigen)).score).toBe(20 + ENTRY_SCORE_MAX_CHANGES_PER_MINUTE - 1);

      // Eine Minute spaeter geht es weiter. Die Grenze ist ein Takt, keine Sperre.
      const spaeter = new Date(at.getTime() + 61_000);
      expect((await saveEntryScore(eigen, { score: 60, actor: "test", at: spaeter })).score).toBe(60);
    } finally {
      await schliessen();
    }
  }, 60_000);
});

describe("Umzug aus der Umgebungsvariablen", () => {
  it("laesst eine gespeicherte Wahl unberuehrt", async () => {
    // Die Datenbank ist nach dem Umzug die einzige Quelle. Eine alte Variable
    // noch einmal zu beruecksichtigen hiesse, bei jedem Neustart die aeltere
    // Wahl gewinnen zu lassen.
    const vorher = await loadEntryScore(db);
    expect(await seedEntryScoreFromEnv(db, { raw: "20", at: new Date() })).toEqual(vorher);
  });

  it("uebernimmt eine bestehende Variable EINMAL in eine leere Tabelle", async () => {
    const { db: leer, close: schliessen } = await createTestDatabase();
    try {
      const at = new Date("2026-10-01T14:00:00Z");
      const uebernommen = await seedEntryScoreFromEnv(leer, { raw: "35", at });
      expect(uebernommen).toMatchObject({ score: 35, source: "SAVED", updatedBy: "PAPER_ENTRY_SCORE" });

      // Der zweite Aufruf aendert nichts mehr, auch mit anderem Wert.
      expect((await seedEntryScoreFromEnv(leer, { raw: "70", at })).score).toBe(35);
    } finally {
      await schliessen();
    }
  }, 30_000);

  it.each([undefined, "", "   ", "ziemlich hoch", "35.5", "9", "96"])(
    "bleibt bei %s bei der Voreinstellung, ohne etwas zu schreiben",
    async (raw) => {
      const { db: leer, close: schliessen } = await createTestDatabase();
      try {
        const gelesen = await seedEntryScoreFromEnv(leer, { raw, at: new Date() });
        expect(gelesen.source).toBe("DEFAULT");
        expect(await leer.select().from(paperSettings)).toHaveLength(0);
      } finally {
        await schliessen();
      }
    },
    30_000,
  );
});
