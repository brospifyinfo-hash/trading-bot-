import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { JobQueueRepository } from "../../repositories/job-queue";
import {
  loadDeadLetters,
  loadErrors,
  loadLatencySummary,
  loadQueueSummary,
  loadRecentJobs,
  loadDashboardState,
} from "../dashboard";

/**
 * Queue-Observability.
 *
 * Die Zahlen, an denen sich spaeter sehen laesst, ob der Bot tatsaechlich
 * autonom laeuft — und nicht nur laeuft. Ein Prozess ohne abgeschlossene
 * Auftraege und ohne Dead Letters tut naemlich gar nichts.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

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

describe("Leere Queue", () => {
  it("zeigt Nullen und keinen erfundenen Zustand", async () => {
    const summary = await loadQueueSummary(db);
    expect(summary).toEqual({
      queued: 0,
      running: 0,
      done: 0,
      dead: 0,
      // Ausdruecklich null und nicht „jetzt".
      oldestQueuedAt: null,
      retryingJobs: 0,
    });
    expect(await loadRecentJobs(db)).toHaveLength(0);
  });

  it("meldet den Worker als nicht lebendig, wenn nie gemessen wurde", async () => {
    const state = await loadDashboardState({ db, now: T0 });
    expect(state.systemState.workerAlive).toBe(false);
    expect(state.systemState.lastProviderSampleAt).toBeNull();
    expect(state.systemState.phase).toBe("WAITING_FOR_MARKET_DATA");
    // Live bleibt in dieser Phase abgeschaltet, unabhaengig von allem anderen.
    expect(state.systemState.liveTradingEnabled).toBe(false);
  });
});

describe("Queue mit Auftraegen", () => {
  it("zaehlt wartende, laufende, erledigte und tote Auftraege", async () => {
    await queue.enqueue({ kind: "SAMPLE_PROVIDER_HEALTH", dedupeKey: "a", at: T0 });
    await queue.enqueue({ kind: "EXPIRE_OPPORTUNITIES", dedupeKey: "b", at: at(1_000) });
    await queue.enqueue({ kind: "RESEARCH_BATCH", dedupeKey: "c", at: at(2_000), maxAttempts: 1 });

    const claimed = await queue.claim({
      workerId: "w1",
      limit: 2,
      now: at(3_000),
      leaseMs: 60_000,
    });
    await queue.complete({ jobId: claimed[0]!.id, at: at(4_000) });
    await queue.fail({
      jobId: claimed[1]!.id,
      error: "kaputt",
      failureClass: "UNKNOWN",
      retryable: false,
      retryAfterMs: 0,
      at: at(5_000),
    });

    const summary = await loadQueueSummary(db);
    expect(summary.done).toBe(1);
    expect(summary.dead).toBe(1);
    expect(summary.queued).toBe(1);
    expect(summary.oldestQueuedAt).not.toBeNull();
  });

  it("zeigt Ausfuehrungsdauer je Auftrag", async () => {
    await queue.enqueue({ kind: "SAMPLE_PROVIDER_HEALTH", dedupeKey: "dauer", at: T0 });
    const [job] = await queue.claim({ workerId: "w1", limit: 1, now: at(1_000), leaseMs: 60_000 });
    await queue.complete({ jobId: job!.id, at: at(3_500) });

    const rows = await loadRecentJobs(db);
    const done = rows.find((r) => r.state === "DONE");
    // Einzelwerte, kein Mittel: ein Durchschnitt glaettet genau den Lauf weg,
    // der zwanzig Minuten brauchte.
    expect(done?.durationMs).toBe(2_500);
  });

  it("laesst laufende Auftraege ohne Dauer stehen", async () => {
    await queue.enqueue({ kind: "SAMPLE_PROVIDER_HEALTH", dedupeKey: "laufend", at: T0 });
    await queue.claim({ workerId: "w1", limit: 1, now: at(1_000), leaseMs: 60_000 });

    const rows = await loadRecentJobs(db);
    // `null`, nicht 0 — der Auftrag ist noch nicht fertig.
    expect(rows[0]?.durationMs).toBeNull();
  });

  it("zaehlt Auftraege in Wiederholung", async () => {
    await queue.enqueue({ kind: "RESEARCH_BATCH", dedupeKey: "retry", at: T0, maxAttempts: 5 });
    const [job] = await queue.claim({ workerId: "w1", limit: 1, now: at(1_000), leaseMs: 60_000 });
    await queue.fail({
      jobId: job!.id,
      error: "503",
      failureClass: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1_000,
      at: at(2_000),
    });
    await queue.claim({ workerId: "w1", limit: 1, now: at(10_000), leaseMs: 60_000 });

    expect((await loadQueueSummary(db)).retryingJobs).toBeGreaterThan(0);
  });

  it("listet Dead Letters mit Grund", async () => {
    await queue.enqueue({ kind: "RESEARCH_BATCH", dedupeKey: "tot", at: T0, maxAttempts: 1 });
    const [job] = await queue.claim({ workerId: "w1", limit: 1, now: at(1_000), leaseMs: 60_000 });
    await queue.fail({
      jobId: job!.id,
      error: "422 Unprocessable",
      failureClass: "INVALID_REQUEST",
      retryable: false,
      retryAfterMs: 0,
      at: at(2_000),
    });

    const dead = await loadDeadLetters(db);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.lastError).toContain("422");
    expect(dead[0]?.failureClass).toBe("INVALID_REQUEST");
  });

  it("fuehrt gescheiterte Auftraege in der Fehlerliste", async () => {
    await queue.enqueue({ kind: "RESEARCH_BATCH", dedupeKey: "fehler", at: T0, maxAttempts: 1 });
    const [job] = await queue.claim({ workerId: "w1", limit: 1, now: at(1_000), leaseMs: 60_000 });
    await queue.fail({
      jobId: job!.id,
      error: "kaputt",
      failureClass: "UNKNOWN",
      retryable: false,
      retryAfterMs: 0,
      at: at(2_000),
    });

    const errors = await loadErrors(db);
    expect(errors[0]?.kind).toBe("JOB:RESEARCH_BATCH");
    expect(errors[0]?.detail).toContain("kaputt");
  });

  it("zeigt die Queue auch im Dashboard-Gesamtbild", async () => {
    await queue.enqueue({ kind: "SAMPLE_PROVIDER_HEALTH", dedupeKey: "dash", at: T0 });
    const state = await loadDashboardState({ db, now: at(1_000) });
    expect(state.queue.queued).toBe(1);
    expect(state.recentJobs).toHaveLength(1);
  });
});

describe("Latenz ohne Messung", () => {
  it("meldet WAITING statt einer Null", async () => {
    expect(await loadLatencySummary(db)).toHaveLength(0);
    const state = await loadDashboardState({ db, now: T0 });
    expect(state.latency.kind).toBe("WAITING");
  });
});

describe("Champion/Challenger ohne Kandidat", () => {
  it("meldet NO EDGE VALIDATED", async () => {
    const state = await loadDashboardState({ db, now: T0 });
    expect(state.championChallenger.kind).toBe("WAITING");
    if (state.championChallenger.kind === "WAITING") {
      expect(state.championChallenger.reason).toContain("NO EDGE VALIDATED");
    }
  });
});
