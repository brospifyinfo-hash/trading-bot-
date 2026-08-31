import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@sae/core";

import {
  InMemoryIdempotencyStore,
  idempotencyKey,
  runOnce,
} from "../idempotency";
import { InMemoryCheckpointStore, runResumable } from "../checkpoint";
import { DEFAULT_BACKOFF, HARD_MAX_DELAY_MS, backoffDelayMs, decideRetry } from "../retry";
import { JobError, runJob } from "../runner";

const T0 = new Date("2026-08-31T12:00:00Z");

describe("Idempotenz", () => {
  it("fuehrt denselben Vorgang nur einmal aus", async () => {
    const store = new InMemoryIdempotencyStore<number>();
    const clock = new FixedClock(T0);
    const fn = vi.fn(async () => 42);
    const key = idempotencyKey("opportunity", { tokenId: "t1", stream: "AUTO_PAPER", at: 1 });

    const first = await runOnce({ store, key, clock, fn });
    const second = await runOnce({ store, key, clock, fn });

    expect(first.kind).toBe("EXECUTED");
    expect(second.kind).toBe("ALREADY_DONE");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("bildet denselben Schluessel unabhaengig von der Feldreihenfolge", () => {
    // Sonst haengt die Idempotenz daran, wie jemand ein Objektliteral geschrieben hat.
    expect(idempotencyKey("s", { a: 1, b: 2 })).toBe(idempotencyKey("s", { b: 2, a: 1 }));
    expect(idempotencyKey("s", { a: 1 })).not.toBe(idempotencyKey("s", { a: 2 }));
  });

  it("gibt den Anspruch nach einem Fehler wieder frei", async () => {
    // Sonst blockiert ein abgestuerzter Worker den Vorgang dauerhaft — und das
    // waere schlimmer als eine Wiederholung: er faende nie statt.
    const store = new InMemoryIdempotencyStore<number>();
    const clock = new FixedClock(T0);
    const key = "k";

    await expect(
      runOnce({ store, key, clock, fn: async () => { throw new Error("boom"); } }),
    ).rejects.toThrow("boom");
    expect(store.claimedKeys).toEqual([]);

    const retry = await runOnce({ store, key, clock, fn: async () => 7 });
    expect(retry.kind).toBe("EXECUTED");
  });

  it("erkennt einen parallel laufenden zweiten Worker", async () => {
    const store = new InMemoryIdempotencyStore<number>();
    const clock = new FixedClock(T0);
    await store.claim("k", T0);
    expect((await runOnce({ store, key: "k", clock, fn: async () => 1 })).kind).toBe("IN_FLIGHT");
  });
});

describe("Wiederholung", () => {
  it("wiederholt eine Netzsperre nicht", () => {
    // Sie aendert sich nicht durch Warten, sondern durch eine Freigabe.
    const decision = decideRetry({ attempt: 1, failure: "BLOCKED" });
    expect(decision.kind).toBe("GIVE_UP");
    if (decision.kind === "GIVE_UP") expect(decision.reason).toMatch(/Netzsperre/);
  });

  it("wiederholt einen eigenen Fehler nicht", () => {
    expect(decideRetry({ attempt: 1, failure: "BAD_REQUEST" }).kind).toBe("GIVE_UP");
  });

  it("wiederholt einen Ausfall mit wachsendem Abstand", () => {
    const first = decideRetry({ attempt: 1, failure: "UNAVAILABLE", random: () => 0.5 });
    const second = decideRetry({ attempt: 2, failure: "UNAVAILABLE", random: () => 0.5 });
    expect(first.kind).toBe("RETRY");
    if (first.kind === "RETRY" && second.kind === "RETRY") {
      expect(second.afterMs).toBeGreaterThan(first.afterMs);
    }
  });

  it("hoert nach der festgelegten Zahl von Versuchen auf", () => {
    const decision = decideRetry({ attempt: DEFAULT_BACKOFF.maxAttempts, failure: "UNAVAILABLE" });
    expect(decision.kind).toBe("GIVE_UP");
  });

  it("deckelt den Abstand hart", () => {
    // Kein Backoff, der laenger dauert als der Scheduler-Takt.
    expect(backoffDelayMs(50, { ...DEFAULT_BACKOFF, maxAttempts: 99, maxDelayMs: 10 ** 9 }, () => 0.5))
      .toBeLessThanOrEqual(HARD_MAX_DELAY_MS);
  });
});

describe("Job-Lauf", () => {
  it("wiederholt und meldet die Zahl der Versuche", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    let calls = 0;
    const outcome = await runJob<string>({
      key: "job-1",
      clock: new FixedClock(T0),
      store,
      sleep: async () => {},
      run: async () => {
        calls += 1;
        if (calls < 3) throw new JobError("upstream weg", 503);
        return "ok";
      },
    });

    expect(outcome.kind).toBe("DONE");
    if (outcome.kind === "DONE") expect(outcome.attempts).toBe(3);
  });

  it("gibt bei einer Netzsperre sofort auf", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    let calls = 0;
    const outcome = await runJob<string>({
      key: "job-2",
      clock: new FixedClock(T0),
      store,
      sleep: async () => {},
      run: async () => {
        calls += 1;
        throw new JobError("CONNECT api.jup.ag:443 failed with 403", 403);
      },
    });

    expect(outcome.kind).toBe("FAILED");
    // Genau ein Aufruf: kein Dauerlauf gegen eine Wand.
    expect(calls).toBe(1);
  });

  it("laesst denselben Job kein zweites Mal laufen", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const clock = new FixedClock(T0);
    let calls = 0;
    const run = async (): Promise<string> => {
      calls += 1;
      return "ok";
    };

    await runJob({ key: "job-3", clock, store, run, sleep: async () => {} });
    const second = await runJob({ key: "job-3", clock, store, run, sleep: async () => {} });

    expect(second.kind).toBe("SKIPPED_DUPLICATE");
    expect(calls).toBe(1);
  });

  it("bricht einen haengenden Aufruf ab", async () => {
    const store = new InMemoryIdempotencyStore<string>();
    const outcome = await runJob<string>({
      key: "job-4",
      clock: new FixedClock(T0),
      store,
      timeoutMs: 20,
      sleep: async () => {},
      run: () => new Promise<string>(() => {}),
    });
    expect(outcome.kind).toBe("FAILED");
  });
});

describe("Wiederaufnahme", () => {
  const units = Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` }));

  it("setzt nach einem Absturz dort fort, wo er stand", async () => {
    const store = new InMemoryCheckpointStore();
    const clock = new FixedClock(T0);
    const seen: string[] = [];

    // Erster Lauf bricht nach vier Einheiten ab.
    await expect(
      runResumable({
        jobKey: "discovery-1",
        units,
        unitId: (u) => u.id,
        store,
        clock,
        maxUnitsPerRun: 100,
        process: async (u) => {
          if (seen.length === 4) throw new Error("Absturz");
          seen.push(u.id);
          return u.id;
        },
      }),
    ).rejects.toThrow("Absturz");

    const second = await runResumable({
      jobKey: "discovery-1",
      units,
      unitId: (u) => u.id,
      store,
      clock,
      maxUnitsPerRun: 100,
      process: async (u) => {
        seen.push(u.id);
        return u.id;
      },
    });

    // Die ersten vier werden nicht erneut abgefragt.
    expect(second.skipped).toBe(4);
    expect(second.processed).toBe(6);
    expect(new Set(seen).size).toBe(10);
    expect(second.completed).toBe(true);
  });

  it("deckelt, wie viel ein einzelner Lauf tut", async () => {
    const store = new InMemoryCheckpointStore();
    const result = await runResumable({
      jobKey: "discovery-2",
      units,
      unitId: (u) => u.id,
      store,
      clock: new FixedClock(T0),
      maxUnitsPerRun: 3,
      process: async (u) => u.id,
    });

    // Ohne Deckel kann ein Job beliebig viele Anfragen erzeugen — genau das,
    // was bei einem Anbieter mit Rate Limit nicht passieren darf.
    expect(result.processed).toBe(3);
    expect(result.completed).toBe(false);
    expect(await store.load("discovery-2")).not.toBeNull();
  });

  it("raeumt den Checkpoint nach Abschluss auf", async () => {
    const store = new InMemoryCheckpointStore();
    await runResumable({
      jobKey: "discovery-3",
      units,
      unitId: (u) => u.id,
      store,
      clock: new FixedClock(T0),
      maxUnitsPerRun: 100,
      process: async (u) => u.id,
    });
    expect(await store.load("discovery-3")).toBeNull();
  });
});
