import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { jobQueue } from "../../schema/queue";
import { loadDeadLetterBreakdown } from "../dead-letters";

/**
 * `dead: 6688` — eine Zahl ohne Ursache.
 *
 * Der Betreiber las sie in der Migrationspruefung als Warnung und konnte
 * nichts damit anfangen. Diese Auszaehlung macht daraus einen Satz, und zwar
 * ohne einen einzigen fremden Text anzuzeigen.
 */

let db: Database;
let close: () => Promise<void>;
const NOW = new Date("2026-10-04T12:00:00Z");

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
});
afterEach(async () => {
  await close();
});

async function job(input: {
  readonly kind: string;
  readonly state: "DEAD" | "QUEUED";
  readonly failureClass?: string | null;
  readonly minutesAgo: number;
  readonly lastError?: string;
}): Promise<void> {
  const at = new Date(NOW.getTime() - input.minutesAgo * 60_000);
  await db.insert(jobQueue).values({
    kind: input.kind,
    dedupeKey: `${input.kind}-${String(input.minutesAgo)}-${String(Math.random())}`,
    state: input.state,
    enqueuedAt: at,
    attempts: 4,
    ...(input.state === "DEAD" ? { finishedAt: at } : {}),
    ...(input.failureClass === undefined || input.failureClass === null
      ? {}
      : { lastFailureClass: input.failureClass }),
    // Ein toter Auftrag OHNE Begruendung ist in dieser Datenbank gar nicht
    // anlegbar: `job_queue_dead_has_reason` verlangt `last_error`. Schoen —
    // die 6688 Zeilen in der Produktion tragen also alle einen Grund, und die
    // Frage ist nur, wer ihn sehen darf.
    ...(input.state === "DEAD"
      ? { lastError: input.lastError ?? "Fehler ohne Besonderheit" }
      : input.lastError === undefined ? {} : { lastError: input.lastError }),
  });
}

it("macht aus einer Zahl eine Ursache — sortiert nach Haeufigkeit", async () => {
  for (let i = 0; i < 5; i++) {
    await job({ kind: "PAPER_SNIPER", state: "DEAD", failureClass: "UNAVAILABLE", minutesAgo: 10 + i });
  }
  await job({ kind: "PAPER_SNIPER", state: "DEAD", failureClass: "RATE_LIMITED", minutesAgo: 60 });
  await job({ kind: "EVALUATE_OPPORTUNITY", state: "DEAD", failureClass: "BAD_REQUEST", minutesAgo: 5 });
  // Ein wartender Auftrag gehoert nicht in diese Auszaehlung.
  await job({ kind: "PAPER_SNIPER", state: "QUEUED", minutesAgo: 1 });

  const b = await loadDeadLetterBreakdown(db);

  expect(b.gesamt).toBe(7);
  expect(b.gruppen[0]).toMatchObject({
    kind: "PAPER_SNIPER", failureClass: "UNAVAILABLE", anzahl: 5,
  });
  // Der Zeitraum sagt, ob das Problem alt ist oder gerade laeuft.
  expect(b.gruppen[0]!.aeltester.getTime()).toBeLessThan(b.gruppen[0]!.neuester.getTime());
  expect(b.gruppen.map((g) => g.anzahl)).toEqual([5, 1, 1]);
});

it("nennt eine fehlende Klassifizierung UNKNOWN statt sie zu verschweigen", async () => {
  await job({ kind: "PAPER_SNIPER", state: "DEAD", failureClass: null, minutesAgo: 3 });
  const b = await loadDeadLetterBreakdown(db);
  expect(b.gruppen[0]?.failureClass).toBe("UNKNOWN");
  expect(b.gesamt).toBe(1);
});

it("fuehrt keinen Fehlertext — auch nicht in einem Feld, das man uebersieht", async () => {
  // Der Grund dieser Regel steht in der Datei: ohne Anmeldung liest jeder mit,
  // der die Adresse kennt, und eine Postgres-Meldung enthaelt das Passwort.
  await job({
    kind: "PAPER_SNIPER", state: "DEAD", failureClass: "UNKNOWN", minutesAgo: 2,
    lastError: "connection to postgres://user:GEHEIM@host/db failed",
  });
  const b = await loadDeadLetterBreakdown(db);

  expect(JSON.stringify(b)).not.toContain("GEHEIM");
  expect(JSON.stringify(b)).not.toContain("postgres://");
});

it("laesst ein Etikett aus, das nicht aus eigenem Code stammen kann", async () => {
  await job({ kind: "PAPER_SNIPER", state: "DEAD", failureClass: "UNAVAILABLE", minutesAgo: 4 });
  // `kind` ist eine Spalte vom Typ `text`. Was dort nicht wie ein eigenes
  // Etikett aussieht, wird nicht angezeigt — eine Oberflaeche ist der falsche
  // Ort, um fremde Zeichenketten auszuprobieren.
  await job({ kind: "<script>alert(1)</script>", state: "DEAD", failureClass: "UNKNOWN", minutesAgo: 4 });

  const b = await loadDeadLetterBreakdown(db);
  expect(b.gruppen.map((g) => g.kind)).toEqual(["PAPER_SNIPER"]);
  expect(b.gesamt).toBe(1);
});

it("ist bei leerer Warteschlange leer und nicht null", async () => {
  const b = await loadDeadLetterBreakdown(db);
  expect(b).toEqual({ gesamt: 0, gruppen: [] });
});
