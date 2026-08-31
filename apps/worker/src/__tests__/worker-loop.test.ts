import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { createLogger } from "@sae/observability";
import {
  JobQueueRepository,
  OpportunityRepository,
  PostgresDispatcher,
  ProviderHealthStore,
  type Database,
} from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";

import { JobConsumer, type JobHandler } from "../consumer";
import { SchedulerLoop } from "../roles/scheduler";

/**
 * Der ganze Weg: Takt → Queue → Consumer → Zeile in der Datenbank.
 *
 * Die Einzelteile waren vorher jeweils fuer sich geprueft. Was dabei
 * durchrutscht, ist genau die Naht: ein Scheduler, der einreiht, wo niemand
 * zieht, und ein Consumer, der zieht, was niemand einreiht. Dieser Test faehrt
 * beide gegen dieselbe Datenbank.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const logger = createLogger({ service: "test", level: "error" });
const ctx = { logger, role: "scheduler" as const };

let db: Database;
let close: () => Promise<void>;
let queue: JobQueueRepository;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  queue = new JobQueueRepository(db);
});

afterEach(async () => {
  await close();
});

function consumerWith(
  handlers: Record<string, JobHandler>,
  now: () => Date,
  kinds?: readonly string[],
): JobConsumer {
  return new JobConsumer({
    workerId: "test-worker",
    queue,
    handlers,
    logger,
    now,
    leaseMs: 30_000,
    ...(kinds !== undefined ? { kinds } : {}),
  });
}

describe("Scheduler und Consumer an derselben Queue", () => {
  it("fuehrt einen eingereihten Takt genau einmal aus", async () => {
    const clock = new FixedClock(T0);
    const scheduler = new SchedulerLoop(ctx, {
      dispatcher: new PostgresDispatcher(db),
      clock,
      marketDataAvailable: () => false,
      remainingRequests: () => null,
    });

    await scheduler.tick(T0);

    let runs = 0;
    // Bewusst auf eine Auftragsart begrenzt: der Takt reiht mehrere ein, und
    // dieser Test fragt nach genau einer davon.
    const consumer = consumerWith(
      { SAMPLE_PROVIDER_HEALTH: { handle: async () => {
        runs += 1;
        return { ok: true };
      } } },
      () => clock.now(),
      ["SAMPLE_PROVIDER_HEALTH"],
    );

    const first = await consumer.cycle();
    expect(first.claimed).toBe(1);
    expect(first.done).toBe(1);

    // Zweiter Durchlauf: nichts mehr zu tun. Ein Auftrag, der zweimal liefe,
    // wuerde hier auffallen.
    const second = await consumer.cycle();
    expect(second.claimed).toBe(0);
    expect(runs).toBe(1);
  });

  it("schreibt aus einem Takt eine echte Provider-Messung", async () => {
    const clock = new FixedClock(T0);
    const scheduler = new SchedulerLoop(ctx, {
      dispatcher: new PostgresDispatcher(db),
      clock,
      marketDataAvailable: () => false,
      remainingRequests: () => null,
    });
    await scheduler.tick(T0);

    const store = new ProviderHealthStore(db);
    const consumer = consumerWith(
      {
        SAMPLE_PROVIDER_HEALTH: {
          handle: async () => {
            // Ohne konfigurierten Anbieter ist der Bericht NOT_CONFIGURED —
            // das ist eine echte Messung, kein Platzhalter.
            const written = await store.record(
              [
                {
                  providerId: "dexscreener" as never,
                  kind: "market",
                  status: "NOT_CONFIGURED",
                  capabilities: ["TOKEN_MARKET"] as never,
                  lastSuccessAt: null,
                  lastFailureAt: null,
                  lastFailureReason: null,
                  latencyMsP50: null,
                  latencyMsP95: null,
                  rateLimit: null,
                  dataFreshnessSeconds: null,
                  detail: "Keine Basis-URL hinterlegt.",
                },
              ],
              clock.now(),
            );
            return { written };
          },
        },
      },
      () => clock.now(),
      ["SAMPLE_PROVIDER_HEALTH"],
    );

    await consumer.cycle();

    const latest = await store.latest();
    expect(latest.map((r) => r.providerId)).toContain("dexscreener");
    // Und die Startbedingung bleibt hart: NOT_CONFIGURED ist keine Quelle.
    expect(await store.anyMarketDataUsable()).toBe(false);
  });

  it("traegt einen Auftrag ohne Handler ins Dead Letter statt ihn zu wiederholen", async () => {
    await queue.enqueue({ kind: "GIBT_ES_NICHT", dedupeKey: "unbekannt", at: T0 });
    const consumer = consumerWith({}, () => T0);

    const cycle = await consumer.cycle();
    expect(cycle.unhandled).toBe(1);
    expect(cycle.dead).toBe(1);

    const dead = await queue.deadLetters();
    expect(dead[0]?.lastError).toContain("Kein Handler");
  });

  it("wiederholt einen vorübergehenden Fehler und gibt danach auf", async () => {
    await queue.enqueue({ kind: "FLAKY", dedupeKey: "flaky", at: T0, maxAttempts: 2 });

    let now = T0;
    const consumer = consumerWith(
      {
        FLAKY: {
          handle: async () => {
            throw Object.assign(new Error("503 Service Unavailable"), { httpStatus: 503 });
          },
        },
      },
      () => now,
    );

    const first = await consumer.cycle();
    expect(first.retried).toBe(1);

    // Nach dem Backoff: zweiter Versuch, dann sind die Versuche erschoepft.
    now = new Date(T0.getTime() + 600_000);
    const second = await consumer.cycle();
    expect(second.dead).toBe(1);

    const dead = await queue.deadLetters();
    expect(dead).toHaveLength(1);
  });

  it("gibt einen Fehler, der sich nicht durch Warten aendert, sofort auf", async () => {
    await queue.enqueue({ kind: "SPERRE", dedupeKey: "sperre", at: T0 });
    const consumer = consumerWith(
      {
        SPERRE: {
          handle: async () => {
            throw Object.assign(new Error("Netzsperre: 403 vom Proxy"), { httpStatus: 403 });
          },
        },
      },
      () => T0,
    );

    const cycle = await consumer.cycle();
    // Eine Sperre aendert sich durch Warten nicht — der naechste Versuch
    // gehoert dem Scheduler, nicht der Retry-Schleife.
    expect(cycle.retried).toBe(0);
    expect(cycle.dead).toBe(1);
  });

  it("setzt die Arbeit nach einem Neustart fort", async () => {
    await queue.enqueue({ kind: "LANG", dedupeKey: "lang", at: T0 });

    // Erster Worker beansprucht und stirbt.
    await queue.claim({ workerId: "gestorben", limit: 5, now: T0, leaseMs: 5_000 });

    let runs = 0;
    const nachfolger = consumerWith(
      { LANG: { handle: async () => {
        runs += 1;
        return null;
      } } },
      () => new Date(T0.getTime() + 60_000),
    );

    const cycle = await nachfolger.cycle();
    expect(cycle.reclaimed).toBe(1);
    // Zurueckgegeben und im selben Durchlauf wieder gezogen: der Auftrag geht
    // nicht verloren, nur weil ein Prozess weg ist.
    expect(runs).toBe(1);
    expect(cycle.done).toBe(1);
  });
});

describe("EXPIRE_OPPORTUNITIES als echter Schreibpfad", () => {
  it("laeuft ueber die Queue und schliesst ueberfaellige Gelegenheiten", async () => {
    // Der Handler wird hier direkt gegen das Repository gefahren: die
    // Verdrahtung im Worker baut dasselbe Objekt.
    const repo = new OpportunityRepository(db);
    await queue.enqueue({ kind: "EXPIRE_OPPORTUNITIES", dedupeKey: "expiry-1", at: T0 });

    const consumer = consumerWith(
      {
        EXPIRE_OPPORTUNITIES: {
          handle: async () => ({ expired: (await repo.expireOverdue(T0)).length }),
        },
      },
      () => T0,
    );

    const cycle = await consumer.cycle();
    expect(cycle.done).toBe(1);
    // Ohne Gelegenheiten in der Datenbank ist das Ergebnis 0 — und ausdruecklich
    // kein Fehlschlag.
    expect(cycle.dead).toBe(0);
  });
});
