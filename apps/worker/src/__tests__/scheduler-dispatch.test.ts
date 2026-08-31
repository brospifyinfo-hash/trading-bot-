import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { InMemoryDispatcher, cadenceWindow, jobRequest } from "@sae/pipeline";
import { createLogger } from "@sae/observability";

import { SchedulerLoop } from "../roles/scheduler";

const T0 = new Date("2026-08-31T12:00:00Z");
const ctx = { logger: createLogger({ service: "test", level: "error" }), role: "scheduler" as const };

function loop(options: { marketData: boolean; clock: FixedClock; remaining?: number | null }) {
  const dispatcher = new InMemoryDispatcher();
  const l = new SchedulerLoop(ctx, {
    dispatcher,
    clock: options.clock,
    marketDataAvailable: () => options.marketData,
    remainingRequests: () => options.remaining ?? null,
  });
  return { loop: l, dispatcher };
}

describe("Scheduler reiht Auftraege ein", () => {
  it("erzeugt ohne Marktdaten nur die Takte, die keine brauchen", async () => {
    const clock = new FixedClock(T0);
    const { loop: l, dispatcher } = loop({ marketData: false, clock });

    await l.tick();

    const kinds = dispatcher.jobs.map((j) => j.kind);
    expect(kinds).toContain("SAMPLE_PROVIDER_HEALTH");
    expect(kinds).not.toContain("DISCOVER_TOKENS");
    expect(kinds).not.toContain("REFRESH_MARKET_DATA");
  });

  it("reiht bei verbundener Quelle die datenabhaengigen Takte ein", async () => {
    const clock = new FixedClock(T0);
    const { loop: l, dispatcher } = loop({ marketData: true, clock });

    await l.tick();

    const kinds = dispatcher.jobs.map((j) => j.kind);
    expect(kinds).toContain("DISCOVER_TOKENS");
    expect(kinds).toContain("REFRESH_MARKET_DATA");
    expect(kinds).toContain("MONITOR_PAPER_POSITION");
  });

  it("reiht denselben Takt im selben Zeitfenster nur einmal ein", async () => {
    // Auch nach einem Neustart: der Schluessel enthaelt das Zeitfenster, nicht
    // den Zeitpunkt.
    const clock = new FixedClock(T0);
    const { loop: l, dispatcher } = loop({ marketData: true, clock });

    await l.tick();
    const first = dispatcher.jobs.length;

    const restarted = new SchedulerLoop(ctx, {
      dispatcher,
      clock,
      marketDataAvailable: () => true,
      remainingRequests: () => null,
    });
    await restarted.tick();

    expect(dispatcher.jobs.length).toBe(first);
  });

  it("erzeugt im naechsten Zeitfenster wieder einen Auftrag", () => {
    const a = jobRequest({
      kind: "DISCOVER_TOKENS",
      cadence: "FAST_DISCOVERY",
      intervalMs: 30_000,
      clock: new FixedClock(T0),
    });
    const b = jobRequest({
      kind: "DISCOVER_TOKENS",
      cadence: "FAST_DISCOVERY",
      intervalMs: 30_000,
      clock: new FixedClock(new Date(T0.getTime() + 31_000)),
    });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it("teilt das Zeitfenster nach dem Takt-Intervall", () => {
    expect(cadenceWindow(T0, 30_000)).toBe(cadenceWindow(new Date(T0.getTime() + 5_000), 30_000));
    expect(cadenceWindow(T0, 30_000)).not.toBe(cadenceWindow(new Date(T0.getTime() + 60_000), 30_000));
  });

  it("laesst einen bereits eingereihten Auftrag den Takt nicht verlangsamen", async () => {
    // Ein abgelehnter Auftrag ist kein Fehlschlag — er lag schon in der Queue.
    const clock = new FixedClock(T0);
    const { loop: l, dispatcher } = loop({ marketData: true, clock });
    await l.tick();

    clock.advance(60_000);
    const before = dispatcher.jobs.length;
    await l.tick();
    expect(dispatcher.jobs.length).toBeGreaterThan(before);
  });
});
