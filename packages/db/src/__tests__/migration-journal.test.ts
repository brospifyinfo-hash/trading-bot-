import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Der Migrationsordner und das Journal muessen deckungsgleich sein.
 *
 * Anlass: `0001_timescale.sql` lag im Ordner, stand aber nicht im Journal.
 * Drizzle liest ausschliesslich das Journal, die Datei wurde also nie
 * ausgefuehrt — sah aber in jedem Verzeichnislisting wie ein angewendeter
 * Schritt aus. Zweimal hat das die Frage ausgeloest, ob das Schema
 * vollstaendig ist.
 *
 * Der umgekehrte Fall waere schlimmer: ein Journal-Eintrag ohne Datei laesst
 * `drizzle-kit migrate` mit "No file … found" abbrechen — im Zweifel mitten in
 * einem Deployment.
 *
 * Beides ist hier eine Testfrage und keine Frage der Aufmerksamkeit.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly when: number; readonly tag: string }[];
}

function journal(): Journal {
  return JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

function sqlFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.slice(0, -".sql".length))
    .sort();
}

describe("Migrationsordner und Journal", () => {
  it("enthaelt zu jeder SQL-Datei einen Journal-Eintrag", () => {
    const tags = new Set(journal().entries.map((e) => e.tag));
    const verwaist = sqlFiles().filter((f) => !tags.has(f));

    // Eine verwaiste Datei wird nie ausgefuehrt und sieht trotzdem nach einer
    // angewendeten Migration aus. Gehoert sie nicht in die Migrationskette,
    // gehoert sie nach packages/db/optional/ — siehe dortiges README.
    expect(verwaist).toEqual([]);
  });

  it("enthaelt zu jedem Journal-Eintrag eine SQL-Datei", () => {
    const dateien = new Set(sqlFiles());
    const fehlend = journal().entries.map((e) => e.tag).filter((t) => !dateien.has(t));

    // Dieser Fall bricht `drizzle-kit migrate` ab, im Zweifel mitten im Deploy.
    expect(fehlend).toEqual([]);
  });

  it("zaehlt gleich viele Dateien wie Eintraege", () => {
    expect(sqlFiles()).toHaveLength(journal().entries.length);
  });
});

describe("Reihenfolge im Journal", () => {
  it("ist nach `when` aufsteigend sortiert", () => {
    // Drizzle wendet an, solange `letzte_angewendete.created_at < when` gilt.
    // Ein Eintrag mit einem kleineren `when` als sein Vorgaenger liefe auf
    // einer frischen Datenbank mit und auf einer bestehenden nie — die beiden
    // liefen dauerhaft auseinander, ohne dass es jemand bemerkt.
    const whens = journal().entries.map((e) => e.when);
    expect(whens).toEqual([...whens].sort((a, b) => a - b));
  });

  it("vergibt `idx` fortlaufend ab 0", () => {
    const idx = journal().entries.map((e) => e.idx);
    expect(idx).toEqual(idx.map((_, i) => i));
  });

  it("nennt jeden Tag genau einmal", () => {
    const tags = journal().entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
