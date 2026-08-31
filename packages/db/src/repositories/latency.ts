import { eq } from "drizzle-orm";
import type { LatencyChain } from "@sae/core";

import type { Database } from "../client";
import { latencySamples } from "../schema/latency";

/**
 * Schreibpfad fuer die Zeitstempelkette.
 *
 * Eine Zeile je Vorgang, die Stufen als eigene Spalten. Es gibt bewusst keine
 * aggregierte Spalte: sobald irgendwo ein `avg_response_ms` steht, wird
 * irgendwann damit simuliert — und ein Median glaettet genau die Faelle weg, in
 * denen die Verzoegerung wehtat (I-9).
 *
 * `ON CONFLICT DO UPDATE` statt `DO NOTHING`: die Kette waechst waehrend des
 * Vorgangs (erst DECIDED, spaeter RESPONDED, zuletzt CONFIRMED). Sie zu
 * verwerfen, weil es schon eine Zeile gibt, wuerde die spaeteren Stufen
 * verlieren.
 */
export class LatencyRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    readonly opportunityId: string;
    readonly stream: string;
    readonly chain: LatencyChain;
  }): Promise<void> {
    const s = input.chain.stages;
    const values = {
      opportunityId: input.opportunityId,
      stream: input.stream,
      observedAt: s.OBSERVED ?? null,
      ingestedAt: s.INGESTED ?? null,
      decidedAt: s.DECIDED ?? null,
      alertedAt: s.ALERTED ?? null,
      seenAt: s.SEEN ?? null,
      respondedAt: s.RESPONDED ?? null,
      quotedAt: s.QUOTED ?? null,
      submittedAt: s.SUBMITTED ?? null,
      confirmedAt: s.CONFIRMED ?? null,
    };

    await this.db
      .insert(latencySamples)
      .values(values)
      .onConflictDoUpdate({ target: latencySamples.opportunityId, set: values });
  }

  async findByOpportunity(
    opportunityId: string,
  ): Promise<typeof latencySamples.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(latencySamples)
      .where(eq(latencySamples.opportunityId, opportunityId))
      .limit(1);
    return row ?? null;
  }
}
