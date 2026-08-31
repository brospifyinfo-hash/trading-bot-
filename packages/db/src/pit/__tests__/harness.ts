import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../client";
import * as schema from "../../schema/index";

const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "../../../migrations");

interface Journal {
  readonly entries: readonly { readonly idx: number; readonly tag: string }[];
}

/**
 * Migrationen in derselben Reihenfolge wie in der Produktion.
 *
 * Bewusst aus dem Journal gelesen und nicht als Liste im Test gepflegt: eine
 * handgefuehrte Liste vergisst irgendwann eine Migration, und dann testet man
 * gegen ein Schema, das es nirgends gibt.
 */
function migrationFiles(): string[] {
  const journal = JSON.parse(
    readFileSync(join(migrationDir, "meta/_journal.json"), "utf8"),
  ) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => join(migrationDir, `${entry.tag}.sql`));
}

/**
 * Eingebettete Postgres-Instanz fuer Tests.
 *
 * PGlite ist echtes Postgres (nach WebAssembly kompiliert), kein Mock. Die
 * Vergleichs-, Sortier- und NULL-Semantik ist identisch zur Produktion — bei
 * einem Test, dessen ganzer Zweck die Korrektheit eines Zeitfilters ist, waere
 * eine nachgebaute Abfrageschicht wertlos.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.waitReady;

  for (const file of migrationFiles()) {
    const sql = readFileSync(file, "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await pg.exec(trimmed);
    }
  }

  const db = drizzle(pg, { schema }) as unknown as Database;
  return { db, close: () => pg.close() };
}
