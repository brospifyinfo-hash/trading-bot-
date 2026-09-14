import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../../testing/harness";
import type { Database } from "../../client";
import { jobQueue } from "../../schema/queue";
import { loadLatestDecisionRun, parseDecisionRun, isRecentObservation } from "../decision-run";
import { loadQueueSummary } from "../dashboard";

const NOW = new Date("2026-09-13T12:00:00Z");
let db: Database;
let close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDatabase()); });
afterAll(async () => { await close(); });

describe("Betriebsdiagnose ohne erfundene Messwerte", () => {
  it("behaelt fehlende Felder alter Laeufe als unbekannt", () => {
    const old = parseDecisionRun({ processed: 5, outcomes: { NO_SOURCE: 5 } }, NOW);
    expect(old.processed).toBe(5);
    expect(old.missingFields).toBeNull();
    expect(old.tracked).toBeNull();
    expect(old.sizing).toBeNull();
    expect(parseDecisionRun(null, NOW).outcomes).toBeNull();
  });

  it("uebernimmt weder Freitext noch kaputte Zaehler als Messung", () => {
    const bad = parseDecisionRun({ processed: -1, outcomes: { NO_SOURCE: "5" },
      missingFields: { "gefälscht\nENTERED": 5 }, sizing: { maximumMinor: "NaN" } }, NOW);
    expect(bad.processed).toBeNull();
    expect(bad.outcomes).toBeNull();
    expect(bad.missingFields).toBeNull();
    expect(bad.sizing).toBeNull();
  });

  it("meldet weder veraltete noch zukuenftige Abschluesse als aktuell", () => {
    expect(isRecentObservation(NOW, NOW)).toBe(true);
    expect(isRecentObservation(new Date(NOW.getTime() - 180_000), NOW)).toBe(false);
    expect(isRecentObservation(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    expect(isRecentObservation(null, NOW)).toBe(false);
  });

  it("laesst Aufraeumen keinen echten Bewertungslauf ueberdecken", async () => {
    expect(await loadLatestDecisionRun(db)).toBeNull();
    await db.insert(jobQueue).values([
      { kind: "EVALUATE_OPPORTUNITY", dedupeKey: "real", state: "DONE", attempts: 1,
        finishedAt: NOW, result: { status: "OK", processed: 2,
          outcomes: { BLOCKED_DATA_QUALITY_TOO_LOW: 2 }, missingFields: { liquidityUsd: 2 } } },
      { kind: "EVALUATE_OPPORTUNITY", dedupeKey: "retired", state: "DONE", attempts: 2,
        finishedAt: new Date(NOW.getTime() + 1), result: { status: "SUPERSEDED" } },
      { kind: "EVALUATE_OPPORTUNITY", dedupeKey: "queued", state: "QUEUED", attempts: 0 },
    ]);
    const run = await loadLatestDecisionRun(db);
    expect(run?.finishedAt).toEqual(NOW);
    expect(run?.outcomes).toEqual({ BLOCKED_DATA_QUALITY_TOO_LOW: 2 });
    expect(run?.missingFields).toEqual({ liquidityUsd: 2 });
    expect((await loadQueueSummary(db)).retryingJobs).toBe(0);
    await db.insert(jobQueue).values({ kind: "REFRESH_MARKET_DATA", dedupeKey: "retry",
      state: "QUEUED", attempts: 2 });
    expect((await loadQueueSummary(db)).retryingJobs).toBe(1);
  });
});
