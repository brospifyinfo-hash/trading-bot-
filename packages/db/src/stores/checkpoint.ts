import { eq } from "drizzle-orm";
import type { CheckpointState, CheckpointStore } from "@sae/pipeline";

import type { Database } from "../client";
import { jobCheckpoints } from "../schema/pipeline";

/**
 * Fortschritt langer Jobs in Postgres.
 *
 * `save` ist ein Upsert: der Checkpoint wird waehrend des Laufs oft
 * geschrieben, und ein vorheriges `SELECT` je Einheit waere eine Abfrage zu
 * viel — bei 400 Einheiten also 400 unnoetige Roundtrips.
 */
export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly db: Database) {}

  async load(jobKey: string): Promise<CheckpointState | null> {
    const [row] = await this.db
      .select()
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobKey, jobKey))
      .limit(1);
    if (row === undefined) return null;
    return {
      jobKey: row.jobKey,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      doneUnits: (row.doneUnits as string[]) ?? [],
      totalUnits: row.totalUnits,
    };
  }

  async save(state: CheckpointState): Promise<void> {
    await this.db
      .insert(jobCheckpoints)
      .values({
        jobKey: state.jobKey,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        doneUnits: [...state.doneUnits],
        totalUnits: state.totalUnits,
      })
      .onConflictDoUpdate({
        target: jobCheckpoints.jobKey,
        set: {
          updatedAt: state.updatedAt,
          doneUnits: [...state.doneUnits],
          totalUnits: state.totalUnits,
        },
      });
  }

  async clear(jobKey: string): Promise<void> {
    await this.db.delete(jobCheckpoints).where(eq(jobCheckpoints.jobKey, jobKey));
  }
}
