import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eur } from "@sae/core";
import { freezeBatch } from "@sae/research";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { paperPositions } from "../../schema/opportunities";
import { OpportunityRepository } from "../opportunities";
import { PaperPositionRepository } from "../paper-positions";
import { ResearchRepository } from "../research";

/**
 * Forschung: Batch → Kandidat → Zustandswechsel, persistent.
 *
 * Und die Sperre, die das Ganze zusammenhaelt: **ein Test-Fixture darf keinen
 * Kandidaten voranbringen.** Ohne sie waere die naheliegendste Art, das System
 * zu taeuschen, ein Entwicklungslauf mit Fixtures, der hinterher wie eine
 * Messreihe aussieht.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;
let research: ResearchRepository;
let seq = 0;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
  const [strategy] = await db.insert(strategies).values({ name: "research" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategy!.id, version: "1.0.0", parameters: {}, reason: "Forschungstest" })
    .returning();
  strategyVersionId = version!.id;
  research = new ResearchRepository(db);
  seq = 0;
});

afterEach(async () => {
  await close();
});

function batch(trainFromMs = 0) {
  return freezeBatch({
    batchId: `batch-${String(trainFromMs)}`,
    boundaries: {
      trainFrom: at(trainFromMs),
      trainTo: at(trainFromMs + 86_400_000),
      oosFrom: at(trainFromMs + 90_000_000),
      oosTo: at(trainFromMs + 176_400_000),
      embargoSeconds: 3_600,
    },
    maxHoldingSeconds: 3_600,
    at: at(trainFromMs + 176_500_000),
  });
}

async function candidate(): Promise<string> {
  const frozen = await research.freezeBatch(batch(seq * 200_000_000));
  seq += 1;
  return research.createCandidate({
    origin: "FEATURE_ANALYSIS",
    researchBatchId: frozen.batchId,
    baseStrategyVersionId: strategyVersionId,
    hypothesis: "Hoehere Liquiditaetsschwelle senkt die Ausfallrate",
    parameters: { minLiquidityUsd: 200_000 },
    hypothesisAt: T0,
  });
}

/** Eine abgeschlossene Position mit der angegebenen Herkunft. */
async function closedPosition(sourceType: "LIVE" | "TEST_FIXTURE"): Promise<void> {
  seq += 1;
  const decidedAt = at(seq * 60_000);
  const created = await new OpportunityRepository(db).create({
    tokenId,
    stream: "AUTO_PAPER",
    decisionKind: "ENTER",
    finalScore: 80,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt,
    respondBy: null,
    provenance: {
      sourceType,
      sourceProvider: sourceType === "TEST_FIXTURE" ? "TEST_FIXTURE:research" : "dexscreener",
      sourceTier: sourceType === "TEST_FIXTURE" ? null : "PRIMARY",
      sourceTimestamp: decidedAt,
      dataTimestamp: decidedAt,
      decisionTimestamp: decidedAt,
      dataQuality: 0.9,
    },
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: {},
      missingFields: [],
      dataCompleteness: 0.9,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: `research-${String(seq)}`,
    },
  });
  if (created.kind !== "CREATED") throw new Error("Fixture");

  const opened = await new PaperPositionRepository(db).open({
    opportunityId: created.opportunityId,
    tokenId,
    stream: "AUTO_PAPER",
    sizingMode: "FIXED_100",
    entryNotional: eur(100),
    entryAmountRaw: 1_000_000n,
    strategyVersionId,
    openedAt: decidedAt,
    fromState: "OFFERED",
    sourceType,
    entryCostsMinor: 150n,
  });
  if (opened.kind !== "OPENED") throw new Error("Fixture");

  await new PaperPositionRepository(db).close({
    positionId: opened.positionId,
    expectedVersion: 0,
    exitReason: "TP1",
    closedAt: new Date(decidedAt.getTime() + 600_000),
    maxAdverseExcursion: null,
    maxFavorableExcursion: null,
    exitEfficiency: null,
  });
}

describe("Research-Persistenz", () => {
  it("friert Zeitgrenzen ein und weist denselben Bereich ein zweites Mal ab", async () => {
    const first = await research.freezeBatch(batch());
    const second = await research.freezeBatch(batch());

    expect(first.kind).toBe("CREATED");
    // I-12: derselbe Datenbereich darf nicht zweimal dieselbe Erkenntnis
    // bestaetigen.
    expect(second.kind).toBe("EXISTS");
    expect(second.batchId).toBe(first.batchId);
  });

  it("legt einen Kandidaten an und protokolliert jeden Zustandswechsel", async () => {
    await closedPosition("LIVE");
    const id = await candidate();

    const advanced = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "BACKTESTED",
      evidence: { trades: 1 },
      reason: null,
      at: at(1_000),
    });
    expect(advanced.kind).toBe("OK");

    const transitions = await research.transitionsFor(id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.fromState).toBe("HYPOTHESIS");
    expect(transitions[0]?.toState).toBe("BACKTESTED");
  });

  it("weist einen Schritt ab, der im Automaten nicht vorgesehen ist", async () => {
    await closedPosition("LIVE");
    const id = await candidate();
    const jump = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "PROMOTED",
      evidence: {},
      reason: null,
      at: at(1_000),
    });
    expect(jump.kind).toBe("ILLEGAL");
    expect(await research.transitionsFor(id)).toHaveLength(0);
  });

  it("erkennt einen Konflikt, wenn der Kandidat woanders steht", async () => {
    await closedPosition("LIVE");
    const id = await candidate();
    await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "BACKTESTED",
      evidence: {},
      reason: null,
      at: at(1_000),
    });

    const stale = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "BACKTESTED",
      evidence: {},
      reason: null,
      at: at(2_000),
    });
    expect(stale.kind).toBe("CONFLICT");
    if (stale.kind === "CONFLICT") expect(stale.actual).toBe("BACKTESTED");
  });
});

describe("TEST_FIXTURE promotet keinen Production-Kandidaten", () => {
  it("zaehlt Fixture-Positionen nicht als Evidenz", async () => {
    await closedPosition("TEST_FIXTURE");
    await closedPosition("TEST_FIXTURE");

    const evidence = await research.productionEvidence();
    expect(evidence.closedPositions).toBe(0);

    // Zur Kontrolle: die Zeilen existieren, sie zaehlen nur nicht.
    expect(await db.select().from(paperPositions)).toHaveLength(2);
  });

  it("verweigert jeden Vorwaertsschritt ohne echte Evidenz", async () => {
    await closedPosition("TEST_FIXTURE");
    const id = await candidate();

    const result = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "BACKTESTED",
      evidence: { quelle: "fixture" },
      reason: null,
      at: at(1_000),
    });
    expect(result.kind).toBe("NO_EVIDENCE");
    if (result.kind === "NO_EVIDENCE") expect(result.detail).toContain("Test-Fixtures");
    // Und es wurde nichts protokolliert.
    expect(await research.transitionsFor(id)).toHaveLength(0);
  });

  it("erlaubt das Verwerfen auch ohne Evidenz", async () => {
    const id = await candidate();
    // Einen Kandidaten zu verwerfen darf nie an fehlenden Daten scheitern —
    // das waere die falsche Richtung.
    const result = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "SHELVED",
      evidence: {},
      reason: "Keine Datengrundlage",
      at: at(1_000),
    });
    expect(result.kind).toBe("OK");
  });

  it("laesst den Schritt zu, sobald echte Evidenz vorliegt", async () => {
    await closedPosition("TEST_FIXTURE");
    await closedPosition("LIVE");

    const evidence = await research.productionEvidence();
    expect(evidence.closedPositions).toBe(1);

    const id = await candidate();
    const result = await research.advance({
      candidateId: id,
      from: "HYPOTHESIS",
      to: "BACKTESTED",
      evidence: { trades: 1 },
      reason: null,
      at: at(1_000),
    });
    expect(result.kind).toBe("OK");
  });
});
