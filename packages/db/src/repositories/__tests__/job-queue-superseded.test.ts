import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createTestDatabase } from "../../testing/index";
import type { Database } from "../../client";
import { jobQueue, jobQueueHistory } from "../../schema/queue";
import { JobQueueRepository } from "../job-queue";

/**
 * Ueberholte Takte.
 *
 * Der Anlass war gemessen und nicht ausgedacht: 9424 offene Auftraege, in rund
 * neun Stunden angesammelt, in denen der Scheduler einreihte und kein Consumer
 * lief. Haette der erste Consumer die der Reihe nach abgearbeitet, waeren
 * daraus rund zweitausend Anbieteranfragen in wenigen Minuten geworden — fuer
 * Arbeit, die der jeweils neueste Auftrag ohnehin erledigt.
 */

const T0 = new Date("2026-09-06T09:00:00Z");

let db: Database;
let close: () => Promise<void>;
let queue: JobQueueRepository;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  queue = new JobQueueRepository(db);
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.delete(jobQueue);
  await db.delete(jobQueueHistory);
});

/** Reiht einen Takt ein, wie es der Scheduler tut: je Zeitfenster ein Schluessel. */
async function tick(
  kind: string,
  fenster: number,
  payload: Record<string, string> = {},
): Promise<void> {
  await queue.enqueue({
    kind,
    payload,
    dedupeKey: `job:${kind}:${String(fenster)}:${JSON.stringify(payload)}`,
    // `at` ist der Einreihungszeitpunkt UND der frueheste Ausfuehrungszeitpunkt.
    // Die Fenster liegen 30 s auseinander, wie beim schnellsten Takt.
    at: new Date(T0.getTime() - (10 - fenster) * 30_000),
  });
}

async function offene(): Promise<number> {
  const rows = await db.select({ id: jobQueue.id }).from(jobQueue).where(eq(jobQueue.state, "QUEUED"));
  return rows.length;
}

describe("Ueberholte Takte zurueckziehen", () => {
  it("laesst genau den neuesten stehen", async () => {
    for (let i = 0; i < 5; i += 1) await tick("REFRESH_MARKET_DATA", i);
    expect(await offene()).toBe(5);

    const retired = await queue.retireSuperseded(T0);
    expect(retired).toBe(4);

    const rest = await db
      .select({ dedupeKey: jobQueue.dedupeKey })
      .from(jobQueue)
      .where(eq(jobQueue.state, "QUEUED"));
    expect(rest).toHaveLength(1);
    // Der neueste, nicht der aelteste: er macht dieselbe Arbeit auf dem
    // aktuellen Stand.
    expect(rest[0]?.dedupeKey).toContain(":4:");
  });

  it("wirft nichts weg, sondern schreibt fest, was passiert ist", async () => {
    for (let i = 0; i < 3; i += 1) await tick("DISCOVER_TOKENS", i);
    await queue.retireSuperseded(T0);

    const done = await db
      .select({ state: jobQueue.state, result: jobQueue.result, finishedAt: jobQueue.finishedAt })
      .from(jobQueue)
      .where(eq(jobQueue.state, "DONE"));
    expect(done).toHaveLength(2);
    // DONE und nicht DEAD: hier ist nichts fehlgeschlagen. Das Dead Letter mit
    // Nicht-Fehlern zu fuellen macht die echten darin unsichtbar.
    expect(done[0]?.result).toMatchObject({ status: "SUPERSEDED" });
    expect(done[0]?.finishedAt).not.toBeNull();
  });

  it("haelt verschiedene Tokens auseinander", async () => {
    // Ohne Vergleich der Nutzlast waere die Bewertung zweier verschiedener
    // Tokens "dieselbe Arbeit" — und einer der beiden fiele still weg.
    await tick("SCORE_TOKEN", 0, { mint: "A" });
    await tick("SCORE_TOKEN", 1, { mint: "B" });
    await tick("SCORE_TOKEN", 2, { mint: "A" });

    const retired = await queue.retireSuperseded(T0);
    expect(retired).toBe(1);

    const rest = await db
      .select({ payload: jobQueue.payload })
      .from(jobQueue)
      .where(eq(jobQueue.state, "QUEUED"));
    expect(rest).toHaveLength(2);
    expect(rest.map((r) => (r.payload as { mint?: string }).mint).sort()).toEqual(["A", "B"]);
  });

  it("fasst laufende und abgeschlossene Auftraege nicht an", async () => {
    await tick("RECONCILE", 0);
    await tick("RECONCILE", 1);
    const claimed = await queue.claim({ workerId: "w1", limit: 1, now: T0, leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);

    // Einer laeuft, einer ist offen — es gibt keinen neueren OFFENEN, der den
    // laufenden ueberholt. Ein Auftrag mitten in der Ausfuehrung darf ohnehin
    // nicht unter dem Worker weggezogen werden.
    const retired = await queue.retireSuperseded(T0);
    expect(retired).toBe(0);
  });

  it("meldet null, wenn jeder Takt fuer sich steht", async () => {
    await tick("DISCOVER_TOKENS", 0);
    await tick("REFRESH_MARKET_DATA", 0);
    await tick("SAMPLE_PROVIDER_HEALTH", 0);
    expect(await queue.retireSuperseded(T0)).toBe(0);
    expect(await offene()).toBe(3);
  });

  it("traegt den zurueckgezogenen Schluessel in die Historie", async () => {
    // Sonst koennte derselbe Fensterschluessel erneut eingereiht werden, und
    // der Rueckzug haette nur den naechsten Durchlauf verschoben.
    for (let i = 0; i < 3; i += 1) await tick("STRATEGY_HEALTH", i);
    await queue.retireSuperseded(T0);

    const history = await db.select({ dedupeKey: jobQueueHistory.dedupeKey }).from(jobQueueHistory);
    expect(history).toHaveLength(2);
  });

  it("kommt mit einem grossen Rueckstand in einem Durchgang klar", async () => {
    // Der reale Fall: 9424 offene Auftraege. Hier klein genug fuer einen Test
    // und gross genug, um zu zeigen, dass es ein Statement ist und keine
    // Schleife ueber Einzelzeilen.
    for (let i = 0; i < 400; i += 1) await tick("REFRESH_MARKET_DATA", i);
    const retired = await queue.retireSuperseded(T0);
    expect(retired).toBe(399);
    expect(await offene()).toBe(1);
  });
});
