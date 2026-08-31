import { systemClock } from "@sae/core";
import {
  DEFAULT_CADENCES,
  afterRun,
  planTick,
  type CadenceId,
  type CadenceState,
} from "@sae/pipeline";
import { summarizeFleet } from "@sae/providers";

import type { RoleContext, RoleHandler } from "../role";
import { buildStatusReports } from "./provider-health";

/**
 * Rolle: scheduler.
 *
 * Kein `setInterval` je Aufgabe, sondern ein Tick, der fragt, was faellig ist.
 * Der Unterschied ist nicht Stil: nur so laesst sich zentral entscheiden, dass
 * bei knappem Anfragebudget die Positionsueberwachung vor der Discovery kommt —
 * getrennte Timer wissen nichts voneinander.
 *
 * Der Tick laeuft auch dann, wenn keine Quelle erreichbar ist. Dann ist er fast
 * leer: nur die Takte ohne Marktdatenbedarf werden faellig, darunter die
 * Provider-Pruefung. Sobald sie eine verbundene Quelle meldet, wird der Rest im
 * naechsten Tick von selbst faellig — es gibt keinen Startknopf.
 */

const TICK_MS = 5_000;

export class SchedulerLoop {
  readonly #states = new Map<CadenceId, CadenceState>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;

  constructor(
    private readonly ctx: RoleContext,
    private readonly run: (id: CadenceId) => Promise<void>,
    private readonly marketDataAvailable: () => boolean,
    private readonly tickMs: number = TICK_MS,
  ) {}

  async tick(now: Date = systemClock.now()): Promise<readonly CadenceId[]> {
    const plan = planTick({
      cadences: DEFAULT_CADENCES,
      states: this.#states,
      now,
      marketDataAvailable: this.marketDataAvailable(),
      // Ohne gemessenes Anbieterbudget wird nicht gedrosselt — aber auch nichts
      // angenommen. Sobald ein Adapter echte Rate-Limit-Header liefert, kommt
      // die Zahl hier herein.
      remainingRequests: null,
    });

    for (const id of plan.toRun) {
      try {
        await this.run(id);
        this.#states.set(id, afterRun(this.#states.get(id), id, now, "OK"));
      } catch (error: unknown) {
        this.#states.set(id, afterRun(this.#states.get(id), id, now, "FAILED"));
        this.ctx.logger.warn(
          { cadence: id, error: error instanceof Error ? error.message : String(error) },
          "Takt gescheitert",
        );
      }
    }

    if (plan.waitingForMarketData.length > 0) {
      this.ctx.logger.debug(
        { waiting: plan.waitingForMarketData },
        "Takte warten auf Marktdaten",
      );
    }

    return plan.toRun;
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

export const schedulerRole: RoleHandler = {
  name: "scheduler",
  async start(ctx: RoleContext): Promise<void> {
    const fleet = summarizeFleet(buildStatusReports(process.env));

    const loop = new SchedulerLoop(
      ctx,
      async (id) => {
        // Die Takte stossen Queues an. Solange keine Quelle erreichbar ist,
        // werden die datenabhaengigen gar nicht erst faellig — hier steht
        // deshalb bewusst kein Platzhalter, der so tut, als liefe etwas.
        ctx.logger.debug({ cadence: id }, "Takt faellig");
      },
      () => fleet.anyMarketDataUsable,
    );

    ctx.logger.info(
      { marketDataUsable: fleet.anyMarketDataUsable, summary: fleet.summary },
      "Scheduler gestartet",
    );
    loop.start();
    schedulerLoop = loop;
  },
  async stop(): Promise<void> {
    schedulerLoop?.stop();
    schedulerLoop = null;
  },
};

let schedulerLoop: SchedulerLoop | null = null;
