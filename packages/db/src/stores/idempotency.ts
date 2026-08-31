import { eq, sql } from "drizzle-orm";
import type { IdempotencyRecord, IdempotencyStore } from "@sae/pipeline";

import type { Database } from "../client";
import { jobExecutions } from "../schema/pipeline";

/**
 * Idempotenz-Register in Postgres.
 *
 * Der ganze Unterschied zur In-Memory-Fassung steckt in `claim`: dort ist es
 * ein `INSERT ... ON CONFLICT DO NOTHING`, kein `SELECT` gefolgt von einem
 * `INSERT`. Zwei Worker, die gleichzeitig denselben Vorgang starten, entscheiden
 * ihre Nebenlaeufigkeit damit in der Datenbank — bei der Lese-Schreib-Variante
 * liegt zwischen beiden Schritten ein Zeitfenster, und genau in dem laufen sie
 * beide durch.
 *
 * Die In-Memory-Fassung bleibt fuer Tests. Im Betrieb ist sie wertlos: sie
 * schuetzt innerhalb eines Prozesses, und es laeuft mehr als einer.
 */
export class PostgresIdempotencyStore<R = unknown> implements IdempotencyStore<R> {
  constructor(private readonly db: Database) {}

  async get(key: string): Promise<IdempotencyRecord<R> | null> {
    const [row] = await this.db
      .select()
      .from(jobExecutions)
      .where(eq(jobExecutions.jobKey, key))
      .limit(1);

    // Ein Anspruch ohne Abschluss ist NICHT „erledigt". Er bedeutet: jemand
    // arbeitet daran oder ist dabei gestorben.
    if (row === undefined || row.completedAt === null) return null;
    return { key, completedAt: row.completedAt, result: row.result as R };
  }

  async claim(key: string, at: Date): Promise<boolean> {
    const inserted = await this.db
      .insert(jobExecutions)
      .values({ jobKey: key, claimedAt: at })
      .onConflictDoNothing({ target: jobExecutions.jobKey })
      .returning({ id: jobExecutions.id });
    return inserted.length > 0;
  }

  async complete(key: string, result: R, at: Date): Promise<void> {
    await this.db
      .update(jobExecutions)
      .set({ completedAt: at, result: result as never })
      .where(eq(jobExecutions.jobKey, key));
  }

  async release(key: string): Promise<void> {
    // Nur einen nicht abgeschlossenen Anspruch freigeben. Ein bereits
    // abgeschlossener Vorgang darf durch einen spaeten Fehlerpfad nicht
    // geloescht werden — sonst laeuft er ein zweites Mal.
    await this.db
      .delete(jobExecutions)
      .where(sql`${jobExecutions.jobKey} = ${key} and ${jobExecutions.completedAt} is null`);
  }

  /** Fehlversuch festhalten, ohne den Anspruch aufzugeben. */
  async recordAttempt(key: string, error: string): Promise<void> {
    await this.db
      .update(jobExecutions)
      .set({ attempts: sql`${jobExecutions.attempts} + 1`, lastError: error })
      .where(eq(jobExecutions.jobKey, key));
  }

  /**
   * Ansprueche, die zu lange offen sind.
   *
   * Ein Worker, der beim Arbeiten stirbt, hinterlaesst einen Anspruch ohne
   * Abschluss. Ohne diese Abfrage bliebe der Vorgang fuer immer blockiert —
   * mit ihr kann ein Aufraeumlauf ihn freigeben und neu einplanen.
   */
  async staleClaims(olderThan: Date): Promise<readonly string[]> {
    const rows = await this.db
      .select({ jobKey: jobExecutions.jobKey })
      .from(jobExecutions)
      .where(sql`${jobExecutions.completedAt} is null and ${jobExecutions.claimedAt} < ${olderThan}`);
    return rows.map((r) => r.jobKey);
  }
}
