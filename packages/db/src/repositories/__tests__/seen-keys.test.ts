import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerId, tokenId as asTokenId, type Clock } from "@sae/core";
import type { MarketObservation } from "@sae/pipeline";
import type { Sourced } from "@sae/providers";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { tokens } from "../../schema/index";
import { tokenSnapshots } from "../../schema/tokens";
import { SnapshotRepository } from "../snapshots";
import { PostgresSeenKeys } from "../../stores/seen-keys";

/**
 * Aufnahme unter mehreren Workern.
 *
 * Die Frage, die hier beantwortet wird: was passiert, wenn zwei Prozesse
 * denselben Datenpunkt gleichzeitig aufnehmen wollen? Antwort: genau einer
 * gewinnt, und zwar entschieden von `UNIQUE (ingest_key)` — nicht von einer
 * Absprache zwischen den beiden, die es nicht gibt.
 */

const MINT = "So11111111111111111111111111111111111111112";
const T0 = new Date("2026-08-31T12:00:00Z");

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return this.at;
  }
}

let db: Database;
let close: () => Promise<void>;
let tokenId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
});

afterEach(async () => {
  await close();
});

const observation: MarketObservation = {
  priceUsd: 0.00042,
  liquidityUsd: 180_000,
  marketCapUsd: 900_000,
  volume24hUsd: 450_000,
  holders: 1_400,
};

function sourced(observedAt = T0): Sourced<MarketObservation> {
  return {
    value: observation,
    observedAt,
    fetchedAt: T0,
    providerId: providerId("dexscreener"),
    tier: "PRIMARY",
    freshnessSeconds: 2,
  };
}

const clock = new FixedClock(T0);

describe("SAME EVENT → Worker A → Worker B → genau ein akzeptierter Event", () => {
  it("nimmt denselben Datenpunkt nur einmal auf, auch bei zwei Prozessen", async () => {
    // Zwei Repository-Instanzen = zwei Prozesse. Sie wissen nichts voneinander.
    const workerA = new SnapshotRepository(db);
    const workerB = new SnapshotRepository(db);

    const [a, b] = await Promise.all([
      workerA.ingest({ tokenId: asTokenId(tokenId), sourcedValue: sourced(), clock }),
      workerB.ingest({ tokenId: asTokenId(tokenId), sourcedValue: sourced(), clock }),
    ]);

    const accepted = [a, b].filter((r) => r.kind === "ACCEPTED");
    const duplicates = [a, b].filter((r) => r.kind === "DUPLICATE");
    expect(accepted).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    const rows = await db.select().from(tokenSnapshots);
    expect(rows).toHaveLength(1);
  });

  it("laesst auch drei gleichzeitige Aufnahmen nur einmal durch", async () => {
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        new SnapshotRepository(db).ingest({
          tokenId: asTokenId(tokenId),
          sourcedValue: sourced(),
          clock,
        }),
      ),
    );
    expect(results.filter((r) => r.kind === "ACCEPTED")).toHaveLength(1);
    expect(await db.select().from(tokenSnapshots)).toHaveLength(1);
  });

  it("erkennt einen bereits aufgenommenen Punkt nach einem Neustart", async () => {
    await new SnapshotRepository(db).ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(),
      clock,
    });

    // Neuer Prozess, leerer Speicher — die Antwort steht in der Datenbank.
    const nachNeustart = await new SnapshotRepository(db).ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(),
      clock,
    });
    expect(nachNeustart.kind).toBe("DUPLICATE");
  });

  it("nimmt einen anderen Beobachtungszeitpunkt als neuen Punkt auf", async () => {
    const repo = new SnapshotRepository(db);
    await repo.ingest({ tokenId: asTokenId(tokenId), sourcedValue: sourced(), clock });

    const later = new Date(T0.getTime() - 30_000);
    const second = await repo.ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(later),
      clock,
    });
    expect(second.kind).toBe("ACCEPTED");
    expect(await db.select().from(tokenSnapshots)).toHaveLength(2);
  });
});

describe("PostgresSeenKeys als Vorpruefer", () => {
  it("kennt einen Schluessel erst nach dem Schreiben", async () => {
    const seen = new PostgresSeenKeys(db);
    const repo = new SnapshotRepository(db);

    const result = await repo.ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(),
      clock,
    });
    if (result.kind !== "ACCEPTED") throw new Error("Fixture");

    expect(await seen.has(result.ingestKey)).toBe(true);
    expect(await seen.has("gibt-es-nicht")).toBe(false);
  });

  it("liest den Schluessel aus dem Snapshot, nicht aus einer zweiten Tabelle", async () => {
    // `add` ist bewusst eine Leeroperation: eine zweite Tabelle koennte von der
    // ersten abweichen, und dann gaebe es zwei Antworten auf dieselbe Frage.
    const seen = new PostgresSeenKeys(db);
    await seen.add("frei-erfunden");
    expect(await seen.has("frei-erfunden")).toBe(false);
  });
});

describe("Abgelehnte Aufnahmen schreiben nichts", () => {
  it("weist Daten aus der Zukunft ab", async () => {
    const future = new Date(T0.getTime() + 600_000);
    const result = await new SnapshotRepository(db).ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(future),
      clock,
    });
    expect(result.kind).toBe("REJECTED");
    expect(await db.select().from(tokenSnapshots)).toHaveLength(0);
  });

  it("weist veraltete Daten ab", async () => {
    const old = new Date(T0.getTime() - 7_200_000);
    const result = await new SnapshotRepository(db).ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: sourced(old),
      clock,
    });
    expect(result.kind).toBe("REJECTED");
    expect(await db.select().from(tokenSnapshots)).toHaveLength(0);
  });

  it("weist eine fehlende Quelle ab, ohne Ersatzwert", async () => {
    const result = await new SnapshotRepository(db).ingest({
      tokenId: asTokenId(tokenId),
      sourcedValue: null,
      clock,
      noSourceReason: "Alle Anbieter gesperrt.",
    });
    expect(result.kind).toBe("REJECTED");
    if (result.kind === "REJECTED") expect(result.decision.kind).toBe("REJECT_NO_SOURCE");
    expect(await db.select().from(tokenSnapshots)).toHaveLength(0);
  });
});
