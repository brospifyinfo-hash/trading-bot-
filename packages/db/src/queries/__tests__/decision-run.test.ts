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

it("preserves per-coin causes and ignores invalid diagnostic payloads", () => {
  const mint = "1".repeat(32);
  const coin = { mint, account: "Offensiv", outcome: "REJECT_DATA_INCOMPLETE", diagnostics: {
    finalScore: 62, completeness: 0.65, requiredCompleteness: 0.7, weightCoverage: 0.6,
    missing: [{ field: "momentum.priceChange5mPct", reason: "NOT_YET_COLLECTED" }], unavailableScores: ["momentum"] } };
  expect(parseDecisionRun({ coinDiagnostics: [coin, { ...coin, mint: "bad" }] }, NOW).coinDiagnostics).toEqual([coin]);
  expect(parseDecisionRun({ coinDiagnostics: [{ ...coin, diagnostics: { ...coin.diagnostics, completeness: -1 } }] }, NOW).coinDiagnostics?.[0]?.diagnostics).toBeUndefined();
});

/**
 * Die Schwelle, die der WORKER benutzt hat — und ihre Herkunft.
 *
 * Die Oberflaeche laeuft bei Vercel, der Worker bei Railway. Zwei getrennte
 * Umgebungen. Laese das Dashboard seine eigene `PAPER_ENTRY_SCORE`, stuende
 * dort eine Zahl, mit der nie jemand entschieden hat — und sie saehe
 * vollkommen plausibel aus. Also meldet der Lauf beides mit, und hier wird
 * festgehalten, dass es ankommt.
 */
it("meldet Schwelle und Herkunft aus dem Lauf, nicht aus der eigenen Umgebung", () => {
  const gesetzt = parseDecisionRun(
    { entryThreshold: 35, entryThresholdSource: "SET",
      accounts: [{ label: "Paper", entryThreshold: 35, outcomes: { WATCH: 4 } }] },
    NOW,
  );
  expect(gesetzt.entryThreshold).toBe(35);
  expect(gesetzt.entryThresholdSource).toBe("SET");
  // Das eine Konto darf nicht an der Etikettenpruefung haengen bleiben.
  expect(gesetzt.accounts).toEqual([{ label: "Paper", entryThreshold: 35, outcomes: { WATCH: 4 } }]);

  expect(parseDecisionRun({ entryThreshold: 50, entryThresholdSource: "DEFAULT" }, NOW).entryThresholdSource)
    .toBe("DEFAULT");

  // Alte Laeufe kannten das Feld nicht. Unbekannt bleibt unbekannt — hier
  // „SET" anzunehmen hiesse zu behaupten, jemand haette gewaehlt.
  expect(parseDecisionRun({ entryThreshold: 75 }, NOW).entryThresholdSource).toBeNull();
  expect(parseDecisionRun({ entryThreshold: 75, entryThresholdSource: "IRGENDWAS" }, NOW).entryThresholdSource).toBeNull();
});

it("laesst historische Laeufe mit den alten Kontoetiketten lesbar", () => {
  // Sonst verschwaende das Dashboard rueckwirkend jeden Lauf von vor der
  // Umstellung auf ein Konto.
  const alt = parseDecisionRun(
    { accounts: [
      { label: "Standard", entryThreshold: 75, outcomes: { WATCH: 1 } },
      { label: "Sehr offensiv", entryThreshold: 35, outcomes: { WATCH: 2 } },
    ] },
    NOW,
  );
  expect(alt.accounts).toHaveLength(2);
});

/**
 * Das eine Konto darf nicht an der Etikettenpruefung haengen bleiben.
 *
 * Die Kontoliste war nach der Umstellung auf ein Konto angepasst, die
 * Pruefung der Coin-Diagnose eine Funktion weiter NICHT. Damit haette die
 * Ansicht „Datenpruefung pro Coin" lautlos aufgehoert zu erscheinen — also
 * genau die Ansicht, die den Grund je Coin nennt, und damit die, auf die
 * jede Fehlersuche hier angewiesen ist.
 */
it("behaelt die Coin-Diagnose des einen Kontos", () => {
  const mint = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const coin = { mint, account: "Paper", outcome: "REJECT_DATA_INCOMPLETE" };
  expect(parseDecisionRun({ coinDiagnostics: [coin] }, NOW).coinDiagnostics).toEqual([coin]);

  // Historische Laeufe bleiben lesbar.
  for (const alt of ["Standard", "Offensiv", "Sehr offensiv", "Legacy"]) {
    expect(parseDecisionRun({ coinDiagnostics: [{ ...coin, account: alt }] }, NOW).coinDiagnostics)
      .toHaveLength(1);
  }
  // Ein erfundenes Etikett kommt weiterhin nicht durch.
  expect(parseDecisionRun({ coinDiagnostics: [{ ...coin, account: "Fremd" }] }, NOW).coinDiagnostics)
    .toEqual([]);
});
