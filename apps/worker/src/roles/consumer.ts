import { hostname } from "node:os";
import { systemClock } from "@sae/core";
import { createDatabase, JobQueueRepository } from "@sae/db";

import { JobConsumer } from "../consumer";
import { buildHandlers } from "../handlers";
import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: consumer.
 *
 * Der Gegenpart des Schedulers. Der Scheduler reiht ein, dieser Prozess
 * arbeitet ab — getrennt, damit ein langsamer Handler den Takt nicht anhaelt.
 *
 * Die Worker-Kennung enthaelt Rechnername und Prozess-ID. Sie steht in
 * `job_queue.claimed_by` und beantwortet im Betrieb die Frage, welcher Prozess
 * einen haengenden Auftrag haelt.
 */

const POLL_MS = 1_000;
const LEASE_MS = 60_000;

let consumer: JobConsumer | null = null;
let closeDb: (() => Promise<void>) | null = null;

export const consumerRole: RoleHandler = {
  name: "consumer",
  async start(ctx: RoleContext): Promise<void> {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url.length === 0) {
      // Ohne Datenbank gibt es keine dauerhafte Queue. Sichtbar scheitern statt
      // im Speicher weiterlaufen: ein Consumer, dessen Auftraege einen Neustart
      // nicht ueberleben, ist schlimmer als keiner.
      throw new Error("consumer benoetigt DATABASE_URL");
    }
    const db = createDatabase(url);
    const queue = new JobQueueRepository(db);

    const loop = new JobConsumer({
      workerId: `${hostname()}:${String(process.pid)}`,
      queue,
      handlers: buildHandlers({ db, logger: ctx.logger, env: process.env }),
      logger: ctx.logger,
      now: () => systemClock.now(),
      leaseMs: LEASE_MS,
    });

    const stats = await queue.stats(systemClock.now());
    ctx.logger.info(
      { role: "consumer", queued: stats.queued, running: stats.running, dead: stats.dead },
      "Consumer gestartet",
    );

    loop.start(POLL_MS);
    consumer = loop;
    closeDb = null;
  },
  async stop(): Promise<void> {
    await consumer?.stop();
    consumer = null;
    await closeDb?.();
    closeDb = null;
  },
};
