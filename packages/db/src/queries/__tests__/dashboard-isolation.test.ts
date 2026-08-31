import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eur } from "@sae/core";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { OpportunityRepository } from "../../repositories/opportunities";
import { PaperPositionRepository } from "../../repositories/paper-positions";
import { loadDashboardState, loadOpportunityCounts, loadPaperSummary } from "../dashboard";

/**
 * Das Dashboard darf Fixture-Daten nicht als Handelsleistung zeigen.
 *
 * Der Test fuellt die Datenbank ausschliesslich mit TEST_FIXTURE-Datensaetzen
 * und prueft danach: die Produktionskacheln stehen weiterhin auf WAITING, und
 * der Testbereich zeigt die Zahlen getrennt.
 */

const MINT = "So11111111111111111111111111111111111111112";
const NOW = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
  const [strategy] = await db.insert(strategies).values({ name: "dash" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategy!.id, version: "1.0.0", parameters: {}, reason: "Dashboardtest" })
    .returning();
  strategyVersionId = version!.id;
});

afterEach(async () => {
  await close();
});

async function seedFixtureTrade(): Promise<void> {
  const decidedAt = at(60_000);
  const created = await new OpportunityRepository(db).create({
    tokenId,
    stream: "AUTO_PAPER",
    decisionKind: "ENTER",
    finalScore: 84,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt,
    respondBy: null,
    provenance: {
      sourceType: "TEST_FIXTURE",
      sourceProvider: "TEST_FIXTURE:dashboard",
      sourceTier: null,
      sourceTimestamp: decidedAt,
      dataTimestamp: decidedAt,
      decisionTimestamp: decidedAt,
      dataQuality: 0.9,
    },
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: { liquidityUsd: 150_000 },
      missingFields: [],
      dataCompleteness: 0.9,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: "dash-fixture",
    },
  });
  if (created.kind !== "CREATED") throw new Error("Fixture");

  await new PaperPositionRepository(db).open({
    opportunityId: created.opportunityId,
    tokenId,
    stream: "AUTO_PAPER",
    sizingMode: "FIXED_100",
    entryNotional: eur(100),
    entryAmountRaw: 1_000_000n,
    strategyVersionId,
    openedAt: at(120_000),
    fromState: "OFFERED",
    sourceType: "TEST_FIXTURE",
    entryCostsMinor: 0n,
  });
}

describe("TEST_FIXTURE erscheint nicht in Produktionskennzahlen", () => {
  it("laesst die Produktionskacheln auf WAITING stehen", async () => {
    await seedFixtureTrade();
    const state = await loadDashboardState({ db, now: NOW });

    // Trotz einer Gelegenheit und einer Position in der Datenbank: fuer die
    // Produktionssicht ist nichts passiert.
    expect(state.headline).toBe("WAITING FOR LIVE MARKET DATA");
    expect(state.opportunities.kind).toBe("WAITING");
    expect(state.paper.kind).toBe("WAITING");
    expect(state.marketDataConnected).toBe(false);
  });

  it("zeigt die Fixture-Daten in einem getrennten Bereich", async () => {
    await seedFixtureTrade();
    const state = await loadDashboardState({ db, now: NOW });

    expect(state.testData).not.toBeNull();
    expect(state.testData?.opportunities.total).toBe(1);
    expect(state.testData?.paper).toHaveLength(1);
    expect(state.testData?.note).toContain("TEST / DEVELOPMENT DATA");
    expect(state.testData?.note).toContain("Keine Handelsleistung");
  });

  it("blendet den Testbereich ohne Fixture-Daten ganz aus", async () => {
    const state = await loadDashboardState({ db, now: NOW });
    // Kein leerer Kasten mit Nullen — der Bereich existiert dann gar nicht.
    expect(state.testData).toBeNull();
  });

  it("trennt die Abfragen selbst, nicht erst die Anzeige", async () => {
    await seedFixtureTrade();

    expect((await loadOpportunityCounts(db, "PRODUCTION")).total).toBe(0);
    expect((await loadOpportunityCounts(db, "TEST")).total).toBe(1);
    expect(await loadPaperSummary(db, "PRODUCTION")).toHaveLength(0);
    expect(await loadPaperSummary(db, "TEST")).toHaveLength(1);
  });
});
