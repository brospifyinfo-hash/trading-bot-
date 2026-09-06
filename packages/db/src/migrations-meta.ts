import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Was dieser Code ueber seine eigenen Migrationen weiss.
 *
 * Ein eigener Einstiegspunkt und ausdruecklich **nicht** Teil von
 * `@sae/db`: das Lesen greift beim Import auf die Festplatte zu, und der
 * Hauptzugang wird auch von der Web-Anwendung geladen, wo der
 * Migrationsordner gar nicht mitgebuendelt wird. Wer die Zahl braucht, holt
 * sie hier — und nur dort, wo das Repository vollstaendig vorliegt.
 *
 * Warum ueberhaupt: die Zahl stand als `10` im Infrastruktur-Smoke-Test und
 * war seit der elften Migration falsch. Der Test meldete dann ausgerechnet
 * nach einer **erfolgreichen** Migration „11 statt 10 — die Datenbank ist
 * neuer als dieser Code". Drizzle selbst liest ausschliesslich dieses Journal;
 * damit es genau eine Wahrheit gibt, liest dieser Code es auch.
 */

const here = dirname(fileURLToPath(import.meta.url));
const journalPath = join(here, "..", "migrations", "meta", "_journal.json");

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

/** Die Kennungen in der Reihenfolge, in der Drizzle sie anwendet. */
export function migrationTags(): readonly string[] {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/** Wie viele Migrationen eine vollstaendig migrierte Datenbank haben muss. */
export const EXPECTED_MIGRATIONS: number = migrationTags().length;
