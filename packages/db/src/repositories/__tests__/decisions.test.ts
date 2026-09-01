import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { decisions, featureObservations } from "../../schema/decisions";
import { opportunities } from "../../schema/opportunities";
import { DecisionRepository, FeatureObservationRepository } from "../decisions";
import { OpportunityRepository } from "../opportunities";

/**
 * Entscheidungen als eigenes Ereignis, und die Herkunft je Feature.
 *
 * Die beiden Zusicherungen, um die es geht:
 *
 * 1. Zwei Gelegenheiten aus einem Lauf teilen sich eine Entscheidung.
 * 2. Ein Feature ohne Beobachtungszeitpunkt kann keine Entscheidung tragen —
 *    durchgesetzt von der Datenbank, nicht von einem Filter.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T0 = new Date("2026-09-01T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;
let snapshotId: string;
let repo: DecisionRepository;
let observations: FeatureObservationRepository;
let seq = 0;

const LIVE = {
  sourceType: "LIVE" as const,
  sourceProvider: "dexscreener",
  sourceTier: "SECONDARY" as const,
  sourceTimestamp: T0,
  dataTimestamp: T0,
  decisionTimestamp: T0,
  dataQuality: 0.6,
};

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
  const [strategy] = await db.insert(strategies).values({ name: "decisions" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategy!.id, version: "1.0.0", parameters: {}, reason: "Test" })
    .returning();
  strategyVersionId = version!.id;
  repo = new DecisionRepository(db);
  observations = new FeatureObservationRepository(db);
  seq = 0;

  // Ein Snapshot, auf den die Entscheidung zeigen kann.
  const created = await new OpportunityRepository(db).create({
    tokenId,
    stream: "AUTO_PAPER",
    decisionKind: "ENTER",
    finalScore: 80,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt: T0,
    respondBy: null,
    provenance: LIVE,
    snapshot: {
      tokenId,
      observedAt: T0,
      features: {},
      missingFields: [],
      dataCompleteness: 0.6,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: "seed",
    },
  });
  if (created.kind !== "CREATED") throw new Error("Fixture");
  snapshotId = created.snapshotId;
});

afterEach(async () => {
  await close();
});

function decisionInput(key = "dec-abc") {
  return {
    decisionKey: key,
    tokenId,
    decidedAt: T0,
    strategyVersionId,
    scoreEngineVersion: "1.0.0",
    decisionKind: "ENTER" as const,
    finalScore: 80,
    dataCompleteness: 0.6,
    featureSnapshotId: snapshotId,
    provenance: LIVE,
  };
}

async function opportunity(stream: "AUTO_PAPER" | "MANUAL_PAPER"): Promise<string> {
  seq += 1;
  const decidedAt = at(seq * 60_000);
  const created = await new OpportunityRepository(db).create({
    tokenId,
    stream,
    decisionKind: "ENTER",
    finalScore: 80,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt,
    respondBy: null,
    provenance: { ...LIVE, dataTimestamp: decidedAt, decisionTimestamp: decidedAt },
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: {},
      missingFields: [],
      dataCompleteness: 0.6,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: `hash-${String(seq)}`,
    },
  });
  if (created.kind !== "CREATED") throw new Error("Fixture");
  return created.opportunityId;
}

describe("Entscheidung als eigenes Ereignis", () => {
  it("legt sie an und findet sie ueber ihren Schluessel wieder", async () => {
    const result = await repo.create(decisionInput());
    expect(result.kind).toBe("CREATED");

    const found = await repo.findByKey("dec-abc");
    expect(found?.decisionKind).toBe("ENTER");
    expect(found?.scoreEngineVersion).toBe("1.0.0");
    expect(found?.branchCount).toBe(0);
  });

  it("erzeugt aus demselben Schluessel keine zweite Entscheidung", async () => {
    const first = await repo.create(decisionInput());
    const second = await repo.create(decisionInput());

    expect(second.kind).toBe("DUPLICATE");
    if (first.kind === "CREATED" && second.kind === "DUPLICATE") {
      expect(second.decisionId).toBe(first.decisionId);
    }
    expect(await db.select().from(decisions)).toHaveLength(1);
  });

  it("entscheidet die Nebenlaeufigkeit in der Datenbank", async () => {
    const results = await Promise.all([
      repo.create(decisionInput("dec-parallel")),
      repo.create(decisionInput("dec-parallel")),
      repo.create(decisionInput("dec-parallel")),
    ]);
    expect(results.filter((r) => r.kind === "CREATED")).toHaveLength(1);
  });
});

describe("Beide Stroeme teilen sich eine Entscheidung", () => {
  it("verknuepft Auto und Manual mit derselben Kennung", async () => {
    const created = await repo.create(decisionInput());
    const auto = await opportunity("AUTO_PAPER");
    const manual = await opportunity("MANUAL_PAPER");

    await repo.attachOpportunity({ decisionId: created.decisionId, opportunityId: auto });
    await repo.attachOpportunity({ decisionId: created.decisionId, opportunityId: manual });

    const linked = await repo.opportunitiesOf(created.decisionId);
    expect(linked.map((l) => l.stream).sort()).toEqual(["AUTO_PAPER", "MANUAL_PAPER"]);

    // Genau darauf laeuft das System hinaus: die beiden sind vergleichbar,
    // weil sie dieselbe Entscheidung gesehen haben.
    const [row] = await db.select().from(decisions).where(eq(decisions.id, created.decisionId));
    expect(row?.branchCount).toBe(2);
  });

  it("zaehlt einen Zweig bei erneutem Verknuepfen nicht doppelt", async () => {
    const created = await repo.create(decisionInput());
    const auto = await opportunity("AUTO_PAPER");

    await repo.attachOpportunity({ decisionId: created.decisionId, opportunityId: auto });
    await repo.attachOpportunity({ decisionId: created.decisionId, opportunityId: auto });

    const [row] = await db.select().from(decisions).where(eq(decisions.id, created.decisionId));
    expect(row?.branchCount).toBe(1);
  });

  it("laesst eine Gelegenheit ohne Entscheidung zu", async () => {
    // Zeilen aus der Zeit vor dieser Tabelle tragen keine Kennung. Das darf
    // kein Fehler sein.
    const orphan = await opportunity("AUTO_PAPER");
    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, orphan));
    expect(row?.decisionId).toBeNull();
  });
});

describe("Feature-Observation mit eigener Herkunft", () => {
  const base = {
    provider: "dexscreener",
    endpoint: "/tokens/v1/solana/{address}",
    receivedAt: at(1_000),
    sourceTier: "SECONDARY" as const,
    dataQuality: 0.6,
    schemaVersion: "unverified",
    adapterVersion: "0.0.0",
    provenance: { sourceType: "LIVE" as const },
  };

  it("speichert einen numerischen Wert mit Herkunft und Alter", async () => {
    const result = await observations.record({
      ...base,
      tokenId,
      featureName: "market.liquidity_usd",
      value: 180_000,
      observedAt: T0,
    });

    expect(result.kind).toBe("RECORDED");
    expect(result.safety).toBe("DECISION_SAFE");

    const [row] = await db.select().from(featureObservations);
    expect(row?.valueNum).toBe(180_000);
    expect(row?.valueBool).toBeNull();
    expect(row?.dataAgeMs).toBe(1_000);
    expect(row?.provider).toBe("dexscreener");
  });

  it("stuft ein Feature ohne Beobachtungszeitpunkt als RESEARCH_ONLY ein", async () => {
    // Der Kernfall bei DexScreener: ein Preis ohne Anbieterzeitpunkt.
    const result = await observations.record({
      ...base,
      tokenId,
      featureName: "market.price_usd",
      value: 0.00042,
      observedAt: null,
    });

    expect(result.safety).toBe("RESEARCH_ONLY");

    const [row] = await db.select().from(featureObservations);
    expect(row?.observedAt).toBeNull();
    // Kein erfundener Zeitstempel, kein geschaetztes Alter.
    expect(row?.dataAgeMs).toBeNull();
    expect(row?.decisionSafety).toBe("RESEARCH_ONLY");
  });

  it("stuft ein Test-Fixture immer als RESEARCH_ONLY ein", async () => {
    const result = await observations.record({
      ...base,
      tokenId,
      featureName: "market.price_usd",
      value: 1,
      observedAt: T0,
      provenance: { sourceType: "TEST_FIXTURE" },
    });
    expect(result.safety).toBe("RESEARCH_ONLY");
  });

  it("speichert denselben Datenpunkt nur einmal", async () => {
    const input = {
      ...base,
      tokenId,
      featureName: "market.liquidity_usd",
      value: 180_000,
      observedAt: T0,
    };
    expect((await observations.record(input)).kind).toBe("RECORDED");
    expect((await observations.record(input)).kind).toBe("DUPLICATE");
    expect(await db.select().from(featureObservations)).toHaveLength(1);
  });

  it("liefert nur entscheidungsfaehige Features aus", async () => {
    await observations.record({
      ...base,
      tokenId,
      featureName: "market.liquidity_usd",
      value: 1,
      observedAt: T0,
    });
    await observations.record({
      ...base,
      tokenId,
      featureName: "market.price_usd",
      value: 2,
      observedAt: null,
    });

    const safe = await observations.decisionSafeFor(tokenId);
    expect(safe.map((s) => s.featureName)).toEqual(["market.liquidity_usd"]);
  });

  it("verknuepft Beobachtungen mit ihrer Entscheidung", async () => {
    const created = await repo.create(decisionInput());
    await observations.record({
      ...base,
      tokenId,
      featureName: "market.liquidity_usd",
      value: 1,
      observedAt: T0,
      decisionId: created.decisionId,
      decisionTimestamp: at(5_000),
    });

    const linked = await observations.forDecision(created.decisionId);
    expect(linked).toHaveLength(1);
  });
});

describe("Look-Ahead und Kausalitaet als Constraint", () => {
  const base = {
    provider: "dexscreener",
    endpoint: "/tokens/v1/solana/{address}",
    sourceTier: "SECONDARY" as const,
    dataQuality: 0.6,
    schemaVersion: "unverified",
    adapterVersion: "0.0.0",
    provenance: { sourceType: "LIVE" as const },
  };

  it("weist eine Beobachtung ab, die nach der Entscheidung liegt", async () => {
    const created = await repo.create(decisionInput());
    // Das Feature wurde NACH der Entscheidung beobachtet. Es darf nicht als
    // deren Grundlage gespeichert werden.
    await expect(
      observations.record({
        ...base,
        tokenId,
        featureName: "market.liquidity_usd",
        value: 1,
        observedAt: at(10_000),
        receivedAt: at(11_000),
        decisionId: created.decisionId,
        decisionTimestamp: at(5_000),
      }),
    ).rejects.toThrow();
  });

  it("weist eine Beobachtung ab, die nach ihrem Empfang liegt", async () => {
    await expect(
      observations.record({
        ...base,
        tokenId,
        featureName: "market.price_usd",
        value: 1,
        observedAt: at(10_000),
        receivedAt: at(1_000),
      }),
    ).rejects.toThrow();
  });

  it("laesst eine Beobachtung ohne Zeitpunkt neben einer Entscheidung zu", async () => {
    // Sie traegt die Entscheidung nicht, aber sie darf gespeichert werden:
    // fuer die Forschung ist sie brauchbar.
    const created = await repo.create(decisionInput());
    const result = await observations.record({
      ...base,
      tokenId,
      featureName: "market.price_usd",
      value: 1,
      observedAt: null,
      receivedAt: at(1_000),
      decisionId: created.decisionId,
      decisionTimestamp: at(5_000),
    });
    expect(result.kind).toBe("RECORDED");
    expect(result.safety).toBe("RESEARCH_ONLY");
  });
});
