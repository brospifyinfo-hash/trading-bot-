import { hostname } from "node:os";
import { systemClock } from "@sae/core";
import { createDatabase, JobQueueRepository, ProviderHealthStore } from "@sae/db";
import { loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";
import type { ProviderStatus } from "@sae/providers";

import { JobConsumer } from "../consumer";
import { buildHandlers } from "../handlers";
import { buildMarketAdapters } from "../pipeline/market-adapters";
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
/** Wie oft der Anbieterzustand neu gelesen wird. */
const STATUS_REFRESH_MS = 30_000;

let consumer: JobConsumer | null = null;
let statusTimer: NodeJS.Timeout | null = null;
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

    // Die Adapter, mit denen die Kette ueberhaupt jemanden fragen kann. Bis
    // hierher war diese Abbildung immer leer, und jeder Abruf endete mit
    // NO_SOURCE — korrekt und nutzlos zugleich.
    const adapters = buildMarketAdapters({
      env: loadEnv(providerEnvSchema, process.env),
      clock: systemClock,
    });

    // Der Anbieterzustand kommt aus den PERSISTIERTEN Messungen des
    // provider-health-Dienstes, nicht aus dem Speicher dieses Prozesses.
    //
    // Je Auftrag frisch gelesen und bewusst nicht zwischengespeichert: ein
    // Anbieter, der um 3 Uhr wiederkommt, soll ohne Neustart bemerkt werden,
    // und ein Anbieter, der ausfaellt, soll nicht noch zehn Minuten lang
    // gefragt werden, weil ein Cache ihn fuer gesund haelt.
    const health = new ProviderHealthStore(db);
    let known: ReadonlyMap<string, ProviderStatus> = new Map();
    const refreshStatus = async (): Promise<void> => {
      const rows = await health.latest();
      known = new Map(rows.map((r) => [r.providerId, r.status as ProviderStatus]));
    };
    await refreshStatus();

    const loop = new JobConsumer({
      workerId: `${hostname()}:${String(process.pid)}`,
      queue,
      handlers: buildHandlers({
        db,
        logger: ctx.logger,
        env: process.env,
        adapters,
        // Ohne Messung: UNAVAILABLE. Ohne Messung ist nichts bekannt, und ein
        // unbekannter Zustand darf keinen Abruf tragen.
        statusOf: (id: KnownProviderId): ProviderStatus => known.get(id) ?? "UNAVAILABLE",
      }),
      logger: ctx.logger,
      now: () => systemClock.now(),
      leaseMs: LEASE_MS,
    });

    const stats = await queue.stats(systemClock.now());
    ctx.logger.info(
      {
        role: "consumer",
        queued: stats.queued,
        running: stats.running,
        dead: stats.dead,
        adapters: [...adapters.keys()].join(","),
        // Welche Anbieter eine Messung haben. Leer heisst: der
        // provider-health-Dienst laeuft noch nicht.
        measured: [...known.keys()].join(",") || "keine",
      },
      "Consumer gestartet",
    );

    // Der Zustand wird zwischen den Auftraegen aufgefrischt. Ein eigener Takt
    // statt einer Abfrage je Auftrag: bei einer Sekunde Poll-Intervall waere
    // das eine zusaetzliche Abfrage pro Sekunde, ohne dass sich der Zustand
    // annaehernd so schnell aendert.
    statusTimer = setInterval(() => {
      void refreshStatus().catch((error: unknown) => {
        ctx.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Anbieterzustand konnte nicht aufgefrischt werden",
        );
      });
    }, STATUS_REFRESH_MS);
    statusTimer.unref();

    loop.start(POLL_MS);
    consumer = loop;
    closeDb = null;
  },
  async stop(): Promise<void> {
    if (statusTimer !== null) clearInterval(statusTimer);
    statusTimer = null;
    await consumer?.stop();
    consumer = null;
    await closeDb?.();
    closeDb = null;
  },
};
