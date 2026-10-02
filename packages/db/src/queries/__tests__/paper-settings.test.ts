import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../testing/harness";
import type { Database } from "../../client";
import { systemEvents } from "../../schema/ops";
import { paperSettings } from "../../schema/settings";
import {
  ENTRY_SCORE_DEFAULT,
  ENTRY_SCORE_MAX_CHANGES_PER_MINUTE,
  MAX_MARKET_CAP_DEFAULT,
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
    expect(gelesen).toEqual({
      score: 35, mode: "VORSICHTIG", entryNotionalMinor: null,
      maxMarketCapUsd: MAX_MARKET_CAP_DEFAULT, maxCoinAgeMinutes: null,
      source: "SAVED", updatedAt: at, updatedBy: "dashboard",
    });

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

/**
 * Der Modus: gespeichert, gelesen, und im Zweifel vorsichtig.
 */
describe("Modus", () => {
  it("steht ohne Zeile auf vorsichtig", async () => {
    const { db: leer, close: schliessen } = await createTestDatabase();
    try {
      expect((await loadEntryScore(leer)).mode).toBe("VORSICHTIG");
    } finally { await schliessen(); }
  }, 30_000);

  it("speichert und liest beide Modi und haelt den Wechsel fest", async () => {
    const { db: eigen, close: schliessen } = await createTestDatabase();
    try {
      const at = new Date("2026-10-02T12:00:00Z");
      await saveEntryScore(eigen, { score: 10, actor: "dashboard", at, mode: "OFFENSIV" });
      expect((await loadEntryScore(eigen)).mode).toBe("OFFENSIV");

      // Weggelassener Modus heisst „unveraendert" — nicht „zurueck auf
      // vorsichtig" und erst recht nicht „offensiv".
      await saveEntryScore(eigen, { score: 20, actor: "dashboard", at });
      const nachher = await loadEntryScore(eigen);
      expect(nachher.score).toBe(20);
      expect(nachher.mode).toBe("OFFENSIV");

      await saveEntryScore(eigen, { score: 20, actor: "dashboard", at, mode: "VORSICHTIG" });
      expect((await loadEntryScore(eigen)).mode).toBe("VORSICHTIG");

      // Der Wechsel steht in der Aenderungsspur. Ohne ihn waere spaeter nicht
      // beantwortbar, warum an einem Tag ploetzlich alles gekauft wurde.
      const ereignisse = await eigen.select().from(systemEvents);
      const wechsel = ereignisse.filter(
        (e) => (e.detail as { modusNach?: string }).modusNach === "OFFENSIV",
      );
      expect(wechsel.length).toBeGreaterThanOrEqual(1);
    } finally { await schliessen(); }
  }, 30_000);
});

/**
 * Der Einsatz je Trade.
 *
 * Drei Zustaende, die auseinandergehalten werden muessen: ein Betrag,
 * ausdruecklich KEINE Vorgabe (`null`), und „nicht angefasst" (`undefined`).
 * Wer die letzten zwei in einem Wert fuehrt, kann eine Loeschung nicht
 * ausdruecken.
 */
describe("Einsatz je Trade", () => {
  it("steht ohne Zeile auf keine Vorgabe", async () => {
    const { db: leer, close: schliessen } = await createTestDatabase();
    try {
      expect((await loadEntryScore(leer)).entryNotionalMinor).toBeNull();
    } finally { await schliessen(); }
  }, 30_000);

  it("speichert einen Betrag, laesst ihn stehen und laesst ihn aufheben", async () => {
    const { db: eigen, close: schliessen } = await createTestDatabase();
    try {
      const at = new Date("2026-10-02T12:00:00Z");
      await saveEntryScore(eigen, { score: 10, actor: "dashboard", at, entryNotionalMinor: 2_500n });
      expect((await loadEntryScore(eigen)).entryNotionalMinor).toBe(2_500n);

      // Weggelassen heisst „unveraendert".
      await saveEntryScore(eigen, { score: 20, actor: "dashboard", at });
      expect((await loadEntryScore(eigen)).entryNotionalMinor).toBe(2_500n);

      // `null` heisst „Vorgabe aufheben" — und ist etwas anderes als 0.
      await saveEntryScore(eigen, { score: 20, actor: "dashboard", at, entryNotionalMinor: null });
      expect((await loadEntryScore(eigen)).entryNotionalMinor).toBeNull();
    } finally { await schliessen(); }
  }, 30_000);

  it.each([0n, -100n, 100_000_001n])("weist %s als Einsatz ab", async (wert) => {
    const { db: eigen, close: schliessen } = await createTestDatabase();
    try {
      await expect(saveEntryScore(eigen, {
        score: 10, actor: "test", at: new Date(), entryNotionalMinor: wert,
      })).rejects.toThrow();
      // Ein Einsatz von 0 ist kein Trade. Ihn als „keine Vorgabe" zu lesen
      // waere eine stille Umdeutung.
      expect(await eigen.select().from(paperSettings)).toHaveLength(0);
    } finally { await schliessen(); }
  }, 30_000);
});

/**
 * Die Aenderungsspur, aus der die Historie im Dashboard entsteht.
 *
 * Eine Reihe von Trades ohne die Aenderungen an den Regeln ist nicht
 * auswertbar: „warum sind an diesem Nachmittag zwanzig Positionen entstanden"
 * beantwortet keine Trade-Liste, sondern die Zeile „Schwelle von 70 auf 10".
 */
it("liefert die Aenderungen fuer die Historie, neueste zuerst", async () => {
  const { loadSettingsHistory } = await import("../history");
  const { db: eigen, close: schliessen } = await createTestDatabase();
  try {
    const t0 = new Date("2026-10-02T10:00:00Z");
    await saveEntryScore(eigen, { score: 70, actor: "dashboard", at: t0 });
    await saveEntryScore(eigen, {
      score: 10, actor: "dashboard", at: new Date(t0.getTime() + 60_000),
      mode: "OFFENSIV", entryNotionalMinor: 5_000n,
    });

    const verlauf = await loadSettingsHistory(eigen);
    expect(verlauf).toHaveLength(2);
    // Neueste zuerst — die Historie liest man von oben.
    expect(verlauf[0]).toMatchObject({
      scoreVon: 70, scoreNach: 10,
      modusVon: "VORSICHTIG", modusNach: "OFFENSIV",
      einsatzVon: null, einsatzNach: 5_000n,
      durch: "dashboard",
    });
    expect(verlauf[1]).toMatchObject({ scoreVon: null, scoreNach: 70 });
  } finally { await schliessen(); }
}, 30_000);
