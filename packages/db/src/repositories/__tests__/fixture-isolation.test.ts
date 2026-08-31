import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { eur } from "@sae/core";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { opportunities as opportunitiesTable, paperPositions } from "../../schema/opportunities";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { OpportunityRepository } from "../opportunities";
import { PaperPositionRepository } from "../paper-positions";

/**
 * TEST_FIXTURE_ISOLATION — durchgesetzt von der Datenbank.
 *
 * Der Schutz besteht aus drei Teilen, und keiner davon ist Anwendungscode:
 *
 * 1. CHECK: `is_test_fixture = (source_type = 'TEST_FIXTURE')`. Die beiden
 *    Spalten koennen nicht auseinanderlaufen.
 * 2. CHECK: ein Fixture-Snapshot muss ein erkennbares Etikett tragen.
 * 3. Zusammengesetzter Fremdschluessel ueber (id, is_test_fixture). Eine echte
 *    Gelegenheit kann nicht auf einen Fixture-Snapshot zeigen, und eine echte
 *    Position nicht an einer Fixture-Gelegenheit haengen.
 *
 * Punkt 3 ist der wichtige: er wirkt auch dann, wenn jemand die Repositories
 * umgeht und direkt schreibt.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;
let repo: OpportunityRepository;

let seq = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
  const [strategy] = await db.insert(strategies).values({ name: "isolation" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategy!.id, version: "1.0.0", parameters: {}, reason: "Isolationstest" })
    .returning();
  strategyVersionId = version!.id;
  repo = new OpportunityRepository(db);
  seq = 0;
});

afterEach(async () => {
  await close();
});

function input(sourceType: "LIVE" | "TEST_FIXTURE") {
  seq += 1;
  const decidedAt = at(seq * 60_000);
  return {
    tokenId,
    stream: "AUTO_PAPER" as const,
    decisionKind: "ENTER" as const,
    finalScore: 82,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt,
    respondBy: null,
    provenance: {
      sourceType,
      sourceProvider: sourceType === "TEST_FIXTURE" ? "TEST_FIXTURE:isolation" : "dexscreener",
      sourceTier: sourceType === "TEST_FIXTURE" ? null : ("PRIMARY" as const),
      sourceTimestamp: decidedAt,
      dataTimestamp: decidedAt,
      decisionTimestamp: decidedAt,
      dataQuality: 0.9,
    },
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: { liquidityUsd: 120_000 },
      missingFields: [],
      dataCompleteness: 0.9,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: `hash-${String(seq)}-${sourceType}`,
    },
  };
}

describe("TEST_FIXTURE_ISOLATION", () => {
  it("markiert Snapshot, Gelegenheit und Position durchgaengig", async () => {
    const created = await repo.create(input("TEST_FIXTURE"));
    if (created.kind !== "CREATED") throw new Error("Fixture");

    const positions = new PaperPositionRepository(db);
    const opened = await positions.open({
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
    if (opened.kind !== "OPENED") throw new Error("Fixture");

    const [position] = await db
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.id, opened.positionId));
    expect(position?.sourceType).toBe("TEST_FIXTURE");
    expect(position?.isTestFixture).toBe(true);
  });

  it("verweigert eine Position mit anderer Herkunft als ihre Gelegenheit", async () => {
    const created = await repo.create(input("TEST_FIXTURE"));
    if (created.kind !== "CREATED") throw new Error("Fixture");

    // Der zusammengesetzte Fremdschluessel greift: eine LIVE-Position an einer
    // Fixture-Gelegenheit gibt es nicht.
    await expect(
      new PaperPositionRepository(db).open({
        opportunityId: created.opportunityId,
        tokenId,
        stream: "AUTO_PAPER",
        sizingMode: "FIXED_100",
        entryNotional: eur(100),
        entryAmountRaw: 1_000_000n,
        strategyVersionId,
        openedAt: at(120_000),
        fromState: "OFFERED",
        sourceType: "LIVE",
        entryCostsMinor: 0n,
      }),
    ).rejects.toThrow();
  });

  it("verweigert einen direkten Schreibzugriff mit widerspruechlichen Spalten", async () => {
    const created = await repo.create(input("LIVE"));
    if (created.kind !== "CREATED") throw new Error("Fixture");

    // Repositories umgangen, direkt geschrieben: der CHECK haelt trotzdem.
    await expect(
      db
        .update(opportunitiesTable)
        .set({ sourceType: "TEST_FIXTURE" })
        .where(eq(opportunitiesTable.id, created.opportunityId)),
    ).rejects.toThrow();
  });

  it("verweigert ein Fixture ohne erkennbares Etikett", async () => {
    const bad = input("TEST_FIXTURE");
    await expect(
      repo.create({
        ...bad,
        provenance: { ...bad.provenance, sourceProvider: "dexscreener" },
      }),
    ).rejects.toThrow(/TEST_FIXTURE/);
  });

  it("verweigert eine LIVE-Herkunft mit Fixture-Etikett", async () => {
    const bad = input("LIVE");
    await expect(
      repo.create({
        ...bad,
        provenance: { ...bad.provenance, sourceProvider: "TEST_FIXTURE:geschummelt" },
      }),
    ).rejects.toThrow();
  });

  it("laesst LIVE und TEST_FIXTURE nebeneinander bestehen, sauber getrennt", async () => {
    await repo.create(input("LIVE"));
    await repo.create(input("TEST_FIXTURE"));

    const live = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.isTestFixture, false));
    const fixture = await db
      .select()
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.isTestFixture, true));

    expect(live).toHaveLength(1);
    expect(fixture).toHaveLength(1);
    expect(live[0]?.sourceType).toBe("LIVE");
    expect(fixture[0]?.sourceType).toBe("TEST_FIXTURE");
  });
});
