import { systemClock, type Clock } from "@sae/core";
import {
  CADENCE_JOB,
  DEFAULT_CADENCES,
  afterRun,
  jobRequest,
  planTick,
  type CadenceId,
  type CadenceState,
  type JobDispatcher,
} from "@sae/pipeline";
import { createDatabase, PostgresDispatcher, ProviderHealthStore } from "@sae/db";
import { summarizeFleet } from "@sae/providers";

import type { RoleContext, RoleHandler } from "../role";
import { buildStatusReports } from "./provider-health";

/**
 * Rolle: scheduler.
 *
 * Der Scheduler REIHT EIN, er arbeitet nicht. Das ist keine Stilfrage: liefe
 * die Arbeit im selben Prozess, wuerde ein langsamer Handler den Takt
 * blockieren, und die Positionsueberwachung kaeme zu spaet, weil die Discovery
 * gerade laenger braucht.
 *
 * Ein Tick fragt, was faellig ist, und erzeugt je faelligem Takt genau einen
 * Auftrag. Der Auftragsschluessel enthaelt das Zeitfenster des Takts — derselbe
 * Takt zweimal ausgeloest (etwa nach einem Neustart) erzeugt denselben
 * Schluessel, und die Queue nimmt ihn nur einmal an.
 */

const TICK_MS = 5_000;

export interface SchedulerDeps {
  readonly dispatcher: JobDispatcher;
  readonly marketDataAvailable: () => boolean;
  readonly clock: Clock;
  /** Verbleibende Anbieteranfragen. `null` = unbekannt, dann wird nicht gedrosselt. */
  readonly remainingRequests: () => number | null;
}

export class SchedulerLoop {
  readonly #states = new Map<CadenceId, CadenceState>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(
    private readonly ctx: RoleContext,
    private readonly deps: SchedulerDeps,
    private readonly tickMs: number = TICK_MS,
  ) {}

  async tick(now: Date = this.deps.clock.now()): Promise<readonly CadenceId[]> {
    const plan = planTick({
      cadences: DEFAULT_CADENCES,
      states: this.#states,
      now,
      marketDataAvailable: this.deps.marketDataAvailable(),
      remainingRequests: this.deps.remainingRequests(),
    });

    const enqueued: CadenceId[] = [];
    for (const id of plan.toRun) {
      const cadence = DEFAULT_CADENCES.find((c) => c.id === id);
      if (cadence === undefined) continue;
      try {
        const accepted = await this.deps.dispatcher.enqueue(
          jobRequest({
            kind: CADENCE_JOB[id],
            cadence: id,
            intervalMs: cadence.intervalMs,
            clock: this.deps.clock,
          }),
        );
        // Auch ein abgelehnter Auftrag ist ein erfolgreicher Lauf: er wurde
        // bereits eingereiht. Als Fehlschlag gewertet wuerde der Takt sich
        // unnoetig verlangsamen.
        this.#states.set(id, afterRun(this.#states.get(id), id, now, "OK"));
        if (accepted) enqueued.push(id);
      } catch (error: unknown) {
        this.#states.set(id, afterRun(this.#states.get(id), id, now, "FAILED"));
        this.ctx.logger.warn(
          { cadence: id, error: error instanceof Error ? error.message : String(error) },
          "Auftrag konnte nicht eingereiht werden",
        );
      }
    }

    if (plan.waitingForMarketData.length > 0) {
      this.ctx.logger.debug({ waiting: plan.waitingForMarketData }, "Takte warten auf Marktdaten");
    }
    return enqueued;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      // Ueberlappende Ticks werden uebersprungen statt aufgestaut: ein
      // langsamer Lauf darf keine Warteschlange von Ticks erzeugen.
      if (this.#running) return;
      this.#running = true;
      void this.tick().finally(() => {
        this.#running = false;
      });
    }, this.tickMs);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** Wie oft der Scheduler die Marktdatenlage neu aus der Datenbank liest. */
const MARKET_DATA_REFRESH_MS = 30_000;

let schedulerLoop: SchedulerLoop | null = null;
let marketDataTimer: ReturnType<typeof setInterval> | null = null;

export const schedulerRole: RoleHandler = {
  name: "scheduler",
  async start(ctx: RoleContext): Promise<void> {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url.length === 0) {
      // Eine Queue im Prozessspeicher waere eine Queue, die jeden Neustart
      // vergisst. Dann faellt genau die Arbeit aus, die nach einem Absturz
      // nachgeholt werden muesste.
      throw new Error("scheduler benoetigt DATABASE_URL");
    }
    const db = createDatabase(url);
    const dispatcher: JobDispatcher = new PostgresDispatcher(db);
    const health = new ProviderHealthStore(db);

    /**
     * Marktdatenlage aus der Datenbank, nicht aus dem Prozessstart.
     *
     * Beim Start einmal zu pruefen hiesse: ein Anbieter, der um 3 Uhr wieder
     * antwortet, bliebe unbemerkt, bis jemand den Scheduler neu startet. Der
     * provider-health-Takt schreibt den Zustand fort, der Scheduler liest ihn.
     */
    let marketDataUsable = summarizeFleet(buildStatusReports(process.env)).anyMarketDataUsable;
    const refreshMarketData = async (): Promise<void> => {
      const usable = await health.anyMarketDataUsable();
      if (usable !== marketDataUsable) {
        ctx.logger.info({ marketDataUsable: usable }, "Marktdatenlage geaendert");
        marketDataUsable = usable;
      }
    };
    await refreshMarketData();
    marketDataTimer = setInterval(() => {
      void refreshMarketData().catch((error: unknown) => {
        ctx.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Marktdatenlage konnte nicht gelesen werden",
        );
      });
    }, MARKET_DATA_REFRESH_MS);

    const loop = new SchedulerLoop(ctx, {
      dispatcher,
      clock: systemClock,
      marketDataAvailable: () => marketDataUsable,
      remainingRequests: () => null,
    });

    ctx.logger.info({ marketDataUsable }, "Scheduler gestartet");
    loop.start();
    schedulerLoop = loop;
  },
  async stop(): Promise<void> {
    schedulerLoop?.stop();
    schedulerLoop = null;
    if (marketDataTimer !== null) clearInterval(marketDataTimer);
    marketDataTimer = null;
  },
};
