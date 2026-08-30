import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../../client";
import * as schema from "../../schema/index";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, "../../../migrations/0000_init.sql");

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

  const sql = readFileSync(migrationPath, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await pg.exec(trimmed);
  }

  const db = drizzle(pg, { schema }) as unknown as Database;
  return { db, close: () => pg.close() };
}
