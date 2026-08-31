import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../pit/__tests__/harness";
import { JobQueueRepository, PostgresDispatcher } from "../job-queue";

/**
 * Die Queue gegen echtes Postgres.
 *
 * Was hier geprueft wird, ist nicht die Bequemlichkeit der Schnittstelle,
 * sondern das, worauf sich der Betrieb verlaesst: dass ein Auftrag nicht
 * doppelt laeuft, dass ein abgestuerzter Worker seine Arbeit nicht mitnimmt und
 * dass ein endgueltig gescheiterter Auftrag sichtbar bleibt statt zu
 * verschwinden.
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

const job = (dedupeKey: string, kind = "SAMPLE_PROVIDER_HEALTH") => ({
  kind,
  dedupeKey,
  payload: { note: dedupeKey },
  at: T0,
});

describe("DUPLICATE_JOB_IS_IDEMPOTENT", () => {
  it("nimmt denselben offenen Auftrag nur einmal an", async () => {
    const first = await queue.enqueue(job("takt-1"));
    const second = await queue.enqueue(job("takt-1"));

    expect(first.kind).toBe("ENQUEUED");
    expect(second.kind).toBe("DUPLICATE");
  });

  it("entscheidet die Nebenlaeufigkeit in der Datenbank", async () => {
    const results = await Promise.all([
      queue.enqueue(job("takt-parallel")),
      queue.enqueue(job("takt-parallel")),
      queue.enqueue(job("takt-parallel")),
    ]);
    expect(results.filter((r) => r.kind === "ENQUEUED")).toHaveLength(1);
  });

  it("belebt einen abgeschlossenen Auftrag nicht wieder", async () => {
    const enqueued = await queue.enqueue(job("takt-erledigt"));
    if (enqueued.kind !== "ENQUEUED") throw new Error("Fixture");
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 30_000,
    });
    await queue.complete({ jobId: claimed!.id, result: { ok: true }, at: at(2_000) });

    // Derselbe fachliche Vorgang darf kein zweites Mal laufen — auch nicht,
    // wenn die Queue-Zeile spaeter aufgeraeumt wird.
    const again = await queue.enqueue(job("takt-erledigt"));
    expect(again.kind).toBe("ALREADY_DONE");
  });

  it("gibt denselben Auftrag nicht an zwei Consumer", async () => {
    await queue.enqueue(job("takt-einmal"));
    const [a, b] = await Promise.all([
      queue.claim({ workerId: "w1", limit: 5, now: at(1_000), leaseMs: 30_000 }),
      queue.claim({ workerId: "w2", limit: 5, now: at(1_000), leaseMs: 30_000 }),
    ]);
    expect(a.length + b.length).toBe(1);
  });
});

describe("Wiederaufnahme nach Neustart", () => {
  it("gibt den Auftrag eines gestorbenen Workers zurueck in die Queue", async () => {
    await queue.enqueue(job("takt-verwaist"));
    const claimed = await queue.claim({
      workerId: "gestorben",
      limit: 5,
      now: at(1_000),
      leaseMs: 10_000,
    });
    expect(claimed).toHaveLength(1);

    // Der Worker meldet sich nicht mehr: die Frist laeuft ab.
    const reclaimed = await queue.reclaimExpired(at(30_000));
    expect(reclaimed).toHaveLength(1);

    const again = await queue.claim({
      workerId: "nachfolger",
      limit: 5,
      now: at(31_000),
      leaseMs: 10_000,
    });
    expect(again).toHaveLength(1);
    // Der Versuchszaehler laeuft weiter: ein Auftrag, der Worker mitreisst, ist
    // ein Verdacht und kein Zufall.
    expect(again[0]!.attempts).toBe(2);
  });

  it("laesst einen Auftrag mit laufender Frist in Ruhe", async () => {
    await queue.enqueue(job("takt-lebt"));
    await queue.claim({ workerId: "w1", limit: 5, now: at(1_000), leaseMs: 60_000 });
    expect(await queue.reclaimExpired(at(30_000))).toHaveLength(0);
  });

  it("verlaengert die Frist eines laufenden Auftrags", async () => {
    await queue.enqueue(job("takt-lang"));
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 10_000,
    });
    expect(await queue.extendLease(claimed!.id, at(120_000))).toBe(true);
    expect(await queue.reclaimExpired(at(60_000))).toHaveLength(0);
  });

  it("traegt einen Auftrag mit erschoepften Versuchen ins Dead Letter, statt ihn ewig zu vergeben", async () => {
    await queue.enqueue({ ...job("takt-endlos"), maxAttempts: 1 });
    await queue.claim({ workerId: "w1", limit: 5, now: at(1_000), leaseMs: 1_000 });
    await queue.reclaimExpired(at(10_000));

    const dead = await queue.deadLetters();
    expect(dead.map((d) => d.dedupeKey)).toContain("takt-endlos");
  });
});

describe("Fehlerbehandlung und Dead Letter", () => {
  it("reiht einen wiederholbaren Fehler mit Verzoegerung wieder ein", async () => {
    await queue.enqueue(job("takt-retry"));
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 30_000,
    });

    const outcome = await queue.fail({
      jobId: claimed!.id,
      error: "503 vom Anbieter",
      failureClass: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 5_000,
      at: at(2_000),
    });
    expect(outcome?.kind).toBe("RETRY");

    // Vor Ablauf der Verzoegerung wird er nicht gezogen — sonst waere der
    // Backoff wirkungslos.
    expect(
      await queue.claim({ workerId: "w1", limit: 5, now: at(3_000), leaseMs: 30_000 }),
    ).toHaveLength(0);
    expect(
      await queue.claim({ workerId: "w1", limit: 5, now: at(9_000), leaseMs: 30_000 }),
    ).toHaveLength(1);
  });

  it("beendet einen nicht wiederholbaren Fehler sofort", async () => {
    await queue.enqueue(job("takt-422"));
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 30_000,
    });
    const outcome = await queue.fail({
      jobId: claimed!.id,
      error: "422 Unprocessable",
      failureClass: "INVALID_REQUEST",
      retryable: false,
      retryAfterMs: 0,
      at: at(2_000),
    });
    expect(outcome?.kind).toBe("DEAD");

    const dead = await queue.deadLetters();
    expect(dead[0]?.lastError).toContain("422");
  });

  it("laesst einen toten Auftrag sichtbar liegen, statt ihn zu loeschen", async () => {
    await queue.enqueue({ ...job("takt-tot"), maxAttempts: 1 });
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 30_000,
    });
    await queue.fail({
      jobId: claimed!.id,
      error: "kaputt",
      failureClass: "UNKNOWN",
      retryable: true,
      retryAfterMs: 1_000,
      at: at(2_000),
    });

    const stats = await queue.stats(at(3_000));
    expect(stats.dead).toBe(1);
    expect(stats.queued).toBe(0);
  });

  it("laesst einen fremden Auftrag nicht abschliessen", async () => {
    await queue.enqueue(job("takt-fremd"));
    const [claimed] = await queue.claim({
      workerId: "w1",
      limit: 5,
      now: at(1_000),
      leaseMs: 1_000,
    });
    await queue.reclaimExpired(at(10_000));

    // Der zurueckgegebene Auftrag gehoert jemand anderem. Ein spaeter
    // eintreffender Abschluss des alten Workers darf ihn nicht als erledigt
    // markieren.
    expect(await queue.complete({ jobId: claimed!.id, at: at(11_000) })).toBe(false);
  });
});

describe("Auswahl der Auftraege", () => {
  it("beachtet Prioritaet und Faelligkeit", async () => {
    await queue.enqueue({ ...job("spaet"), priority: 200 });
    await queue.enqueue({ ...job("frueh"), priority: 10 });

    const claimed = await queue.claim({
      workerId: "w1",
      limit: 1,
      now: at(1_000),
      leaseMs: 30_000,
    });
    expect(claimed[0]?.dedupeKey).toBe("frueh");
  });

  it("zieht nur die angeforderten Auftragsarten", async () => {
    await queue.enqueue(job("a", "SAMPLE_PROVIDER_HEALTH"));
    await queue.enqueue(job("b", "RESEARCH_BATCH"));

    const claimed = await queue.claim({
      workerId: "w1",
      kinds: ["RESEARCH_BATCH"],
      limit: 5,
      now: at(1_000),
      leaseMs: 30_000,
    });
    expect(claimed.map((c) => c.kind)).toEqual(["RESEARCH_BATCH"]);
  });

  it("zieht einen Auftrag mit spaeterer Faelligkeit noch nicht", async () => {
    await queue.enqueue({ ...job("spaeter"), runAfter: at(60_000) });
    expect(
      await queue.claim({ workerId: "w1", limit: 5, now: at(1_000), leaseMs: 30_000 }),
    ).toHaveLength(0);
  });
});

describe("Dispatcher als Schnittstelle des Schedulers", () => {
  it("reiht ein und lehnt die Wiederholung desselben Takts ab", async () => {
    const dispatcher = new PostgresDispatcher(db);
    const request = {
      kind: "SAMPLE_PROVIDER_HEALTH" as const,
      payload: {},
      dedupeKey: "scheduler:fenster-1",
      enqueuedAt: T0,
    };
    expect(await dispatcher.enqueue(request)).toBe(true);
    expect(await dispatcher.enqueue(request)).toBe(false);
  });
});
