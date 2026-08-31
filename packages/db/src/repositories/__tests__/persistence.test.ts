import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eur } from "@sae/core";

import type { Database } from "../../client";
import { createTestDatabase } from "../../pit/__tests__/harness";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { OpportunityRepository } from "../opportunities";
import { PaperPositionRepository } from "../paper-positions";
import { PostgresIdempotencyStore } from "../../stores/idempotency";
import { PostgresCheckpointStore } from "../../stores/checkpoint";
import { ProviderHealthStore } from "../../stores/provider-health";

/**
 * Persistenz gegen echtes Postgres.
 *
 * Alle Zusicherungen dieser Datei gelten prozessuebergreifend. Die
 * In-Memory-Fassungen schuetzen innerhalb eines Prozesses — im Betrieb laeuft
 * mehr als einer, und dann traegt nur die Datenbank.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;
let opportunities: OpportunityRepository;
let positions: PaperPositionRepository;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;

  const [strategy] = await db.insert(strategies).values({ name: "persistence" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({
      strategyId: strategy!.id,
      version: "1.0.0",
      parameters: {},
      reason: "Testfixture fuer die Persistenzschicht",
    })
    .returning();
  strategyVersionId = version!.id;

  opportunities = new OpportunityRepository(db);
  positions = new PaperPositionRepository(db);
});

afterAll(async () => {
  await close();
});

let seq = 0;
/** Zeitpunkte nach einer Entscheidung — closed_at darf nie davor liegen. */
const after = (input: { decidedAt: Date }, ms: number): Date =>
  new Date(input.decidedAt.getTime() + ms);

function opportunityInput(overrides: { decidedAt?: Date; stream?: "AUTO_PAPER" | "MANUAL_PAPER" } = {}) {
  seq += 1;
  const decidedAt = overrides.decidedAt ?? at(seq * 60_000);
  return {
    tokenId,
    stream: overrides.stream ?? ("AUTO_PAPER" as const),
    decisionKind: "ENTER" as const,
    finalScore: 82,
    reasons: [],
    risks: [],
    rejectionReasons: [],
    strategyVersionId,
    decidedAt,
    respondBy: new Date(decidedAt.getTime() + 300_000),
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: { liquidityUsd: 120_000 },
      missingFields: [],
      dataCompleteness: 0.8,
      scoreEngineVersion: "1.0.0",
      featureSetVersion: "1",
      inputHash: `hash-${seq}`,
    },
  };
}

describe("DUPLICATE_EVENT_CANNOT_CREATE_DUPLICATE_TRADE", () => {
  it("erzeugt aus demselben Entscheidungszeitpunkt nur eine Gelegenheit", async () => {
    const input = opportunityInput();
    const first = await opportunities.create(input);
    const second = await opportunities.create(input);

    expect(first.kind).toBe("CREATED");
    expect(second.kind).toBe("DUPLICATE");
    if (first.kind === "CREATED" && second.kind === "DUPLICATE") {
      expect(second.opportunityId).toBe(first.opportunityId);
    }
  });

  it("erzeugt zu einer Gelegenheit nur eine Paper-Position", async () => {
    const input = opportunityInput();
    const created = await opportunities.create(input);
    expect(created.kind).toBe("CREATED");
    if (created.kind !== "CREATED") return;

    const open = {
      opportunityId: created.opportunityId,
      tokenId,
      stream: "AUTO_PAPER" as const,
      sizingMode: "FIXED_100" as const,
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId,
      openedAt: after(input, 10_000),
      fromState: "OFFERED" as const,
    };

    const a = await positions.open(open);
    const b = await positions.open(open);

    expect(a.kind).toBe("OPENED");
    // Zweiter Aufruf desselben Jobs: keine zweite Position, kein Fehler.
    expect(b.kind).toBe("ALREADY_OPEN");
  });

  it("legt keine Position an, wenn die Gelegenheit nicht im erwarteten Zustand ist", async () => {
    const input = opportunityInput();
    const created = await opportunities.create(input);
    if (created.kind !== "CREATED") throw new Error("Fixture");

    await opportunities.transition({
      opportunityId: created.opportunityId,
      from: "OFFERED",
      to: "REJECTED",
      at: after(input, 5_000),
    });

    const result = await positions.open({
      opportunityId: created.opportunityId,
      tokenId,
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId,
      openedAt: after(input, 10_000),
      fromState: "OFFERED",
    });

    expect(result.kind).toBe("NOT_CONFIRMED");
    if (result.kind === "NOT_CONFIRMED") expect(result.actualState).toBe("REJECTED");
  });
});

describe("DUPLICATE_JOB_IS_IDEMPOTENT", () => {
  it("laesst nur einen von zwei gleichzeitigen Ansprüchen durch", async () => {
    const store = new PostgresIdempotencyStore(db);
    const results = await Promise.all([
      store.claim("job-parallel", T0),
      store.claim("job-parallel", T0),
      store.claim("job-parallel", T0),
    ]);
    // Die Nebenlaeufigkeit wird in der Datenbank entschieden, nicht durch ein
    // vorheriges SELECT.
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("meldet einen abgeschlossenen Vorgang als erledigt", async () => {
    const store = new PostgresIdempotencyStore<{ n: number }>(db);
    await store.claim("job-done", T0);
    await store.complete("job-done", { n: 7 }, at(1_000));

    const record = await store.get("job-done");
    expect(record?.result).toEqual({ n: 7 });
  });

  it("meldet einen laufenden Anspruch NICHT als erledigt", async () => {
    // Sonst wuerde ein zweiter Worker den Vorgang ueberspringen, obwohl der
    // erste noch arbeitet — und das Ergebnis fehlte.
    const store = new PostgresIdempotencyStore(db);
    await store.claim("job-running", T0);
    expect(await store.get("job-running")).toBeNull();
  });

  it("gibt einen Anspruch nach einem Fehler frei", async () => {
    const store = new PostgresIdempotencyStore(db);
    await store.claim("job-failed", T0);
    await store.release("job-failed");
    expect(await store.claim("job-failed", T0)).toBe(true);
  });

  it("gibt einen abgeschlossenen Vorgang nicht frei", async () => {
    // Ein spaeter Fehlerpfad darf einen fertigen Vorgang nicht loeschen —
    // sonst laeuft er ein zweites Mal.
    const store = new PostgresIdempotencyStore(db);
    await store.claim("job-complete-then-release", T0);
    await store.complete("job-complete-then-release", null, at(1_000));
    await store.release("job-complete-then-release");
    expect(await store.claim("job-complete-then-release", T0)).toBe(false);
  });

  it("findet Ansprüche verstorbener Worker", async () => {
    const store = new PostgresIdempotencyStore(db);
    await store.claim("job-stale", T0);
    const stale = await store.staleClaims(at(60_000));
    expect(stale).toContain("job-stale");
  });
});

describe("Wiederaufnahme nach Neustart", () => {
  it("behaelt den Fortschritt ueber Prozessgrenzen hinweg", async () => {
    const first = new PostgresCheckpointStore(db);
    await first.save({
      jobKey: "discovery-run",
      startedAt: T0,
      updatedAt: at(1_000),
      doneUnits: ["a", "b", "c"],
      totalUnits: 10,
    });

    // Neue Instanz = neuer Prozess.
    const second = new PostgresCheckpointStore(db);
    const loaded = await second.load("discovery-run");
    expect(loaded?.doneUnits).toEqual(["a", "b", "c"]);
  });

  it("ueberschreibt den Fortschritt statt eine zweite Zeile anzulegen", async () => {
    const store = new PostgresCheckpointStore(db);
    await store.save({
      jobKey: "discovery-upsert",
      startedAt: T0,
      updatedAt: at(1_000),
      doneUnits: ["a"],
      totalUnits: 5,
    });
    await store.save({
      jobKey: "discovery-upsert",
      startedAt: T0,
      updatedAt: at(2_000),
      doneUnits: ["a", "b"],
      totalUnits: 5,
    });
    expect((await store.load("discovery-upsert"))?.doneUnits).toEqual(["a", "b"]);
  });
});

describe("Optimistische Sperre auf Positionen", () => {
  it("laesst zwei gleichzeitige Aenderungen nicht beide durch", async () => {
    const input = opportunityInput();
    const created = await opportunities.create(input);
    if (created.kind !== "CREATED") throw new Error("Fixture");
    const opened = await positions.open({
      opportunityId: created.opportunityId,
      tokenId,
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000_000n,
      strategyVersionId,
      openedAt: after(input, 10_000),
      fromState: "OFFERED",
    });
    if (opened.kind !== "OPENED") throw new Error("Fixture");

    const fill = {
      positionId: opened.positionId,
      expectedVersion: 0,
      soldAmountRaw: 200_000n,
      realizedPnlMinorDelta: 500n,
      costsPaidMinorDelta: 30n,
      at: after(input, 20_000),
      kind: "PARTIAL_TP",
      detail: { level: 1 },
    };

    const a = await positions.applyFill(fill);
    const b = await positions.applyFill(fill);

    expect(a.kind).toBe("APPLIED");
    // Der zweite Worker verliert und liest neu, statt einen Teilverkauf zu
    // ueberschreiben.
    expect(b.kind).toBe("STALE");
  });
});

describe("Datenbank-Constraints", () => {
  it("weist einen Restbestand ueber dem Einstieg ab", async () => {
    const input = opportunityInput();
    const created = await opportunities.create(input);
    if (created.kind !== "CREATED") throw new Error("Fixture");
    const opened = await positions.open({
      opportunityId: created.opportunityId,
      tokenId,
      stream: "AUTO_PAPER",
      sizingMode: "FIXED_100",
      entryNotional: eur(100),
      entryAmountRaw: 1_000n,
      strategyVersionId,
      openedAt: after(input, 10_000),
      fromState: "OFFERED",
    });
    if (opened.kind !== "OPENED") throw new Error("Fixture");

    // Mehr verkaufen als vorhanden: die Datenbank lehnt ab, nicht die Anwendung.
    await expect(
      positions.applyFill({
        positionId: opened.positionId,
        expectedVersion: 0,
        soldAmountRaw: 5_000n,
        realizedPnlMinorDelta: 0n,
        costsPaidMinorDelta: 0n,
        at: after(input, 20_000),
        kind: "OVERSELL",
        detail: {},
      }),
    ).rejects.toThrow();
  });

  it("weist ein Antwortfenster vor der Entscheidung ab", async () => {
    const input = opportunityInput();
    await expect(
      opportunities.create({
        ...input,
        decidedAt: at(900_000),
        respondBy: at(800_000),
        snapshot: { ...input.snapshot, observedAt: at(900_000), inputHash: "hash-inverted" },
      }),
    ).rejects.toThrow();
  });
});

describe("Ablauf von Gelegenheiten", () => {
  it("schliesst ueberfaellige Gelegenheiten zeitgesteuert", async () => {
    const created = await opportunities.create(
      opportunityInput({ decidedAt: at(2_000_000) }),
    );
    if (created.kind !== "CREATED") throw new Error("Fixture");

    // I-11: der Uebergang kommt von der Zeit, nicht vom naechsten Login.
    const expired = await opportunities.expireOverdue(at(3_000_000));
    expect(expired).toContain(created.opportunityId);

    const row = await opportunities.findById(created.opportunityId);
    expect(row?.state).toBe("EXPIRED");
  });

  it("laesst eine bestaetigte Gelegenheit nicht ablaufen", async () => {
    const created = await opportunities.create(
      opportunityInput({ decidedAt: at(4_000_000), stream: "MANUAL_PAPER" }),
    );
    if (created.kind !== "CREATED") throw new Error("Fixture");
    await opportunities.transition({
      opportunityId: created.opportunityId,
      from: "OFFERED",
      to: "USER_CONFIRMED",
      at: at(4_100_000),
    });

    const expired = await opportunities.expireOverdue(at(5_000_000));
    expect(expired).not.toContain(created.opportunityId);
  });
});

describe("Provider-Health-Verlauf", () => {
  it("schreibt eine Zeile je Messung und erkennt Doppelmessungen", async () => {
    const store = new ProviderHealthStore(db);
    const report = {
      providerId: "dexscreener" as never,
      kind: "market" as const,
      status: "BLOCKED" as const,
      capabilities: ["TOKEN_MARKET"] as never,
      lastSuccessAt: null,
      lastFailureAt: T0,
      lastFailureReason: "CONNECT failed with 403",
      latencyMsP50: null,
      latencyMsP95: null,
      rateLimit: null,
      dataFreshnessSeconds: null,
      detail: "gesperrt",
    };

    expect(await store.record([report], at(100_000))).toBe(1);
    // Derselbe Takt zweimal: kein zweiter Messpunkt, sonst verzerrt er jede
    // Auswertung ueber die Zeit.
    expect(await store.record([report], at(100_000))).toBe(0);
  });

  it("beantwortet „seit wann in diesem Zustand“", async () => {
    const store = new ProviderHealthStore(db);
    const base = {
      providerId: "birdeye" as never,
      kind: "market" as const,
      capabilities: ["TOKEN_MARKET"] as never,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      latencyMsP50: null,
      latencyMsP95: null,
      rateLimit: null,
      dataFreshnessSeconds: null,
      detail: null,
    };
    await store.record([{ ...base, status: "UNAVAILABLE" as const }], at(200_000));
    await store.record([{ ...base, status: "BLOCKED" as const }], at(300_000));
    await store.record([{ ...base, status: "BLOCKED" as const }], at(400_000));

    const since = await store.statusSince("birdeye");
    expect(since?.status).toBe("BLOCKED");
    expect(since?.since).toEqual(at(300_000));
  });

  it("liefert ohne Messung kein „seit jetzt“", async () => {
    const store = new ProviderHealthStore(db);
    expect(await store.statusSince("gibt-es-nicht")).toBeNull();
  });
});
