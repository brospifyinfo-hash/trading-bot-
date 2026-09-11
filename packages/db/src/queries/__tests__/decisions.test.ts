import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { strategies, strategyVersions, tokens } from "../../schema/index";
import { OpportunityRepository } from "../../repositories/opportunities";
import { loadDecisionSummary } from "../dashboard";

/**
 * Warum der Bot nicht gekauft hat — als Zahl auf der Oberflaeche.
 *
 * Die Auskunft stand bisher nur im Log (§122). Das Dashboard zeigte
 * Lebenszyklus-Zustaende von Gelegenheiten und beantwortete damit eine andere
 * Frage als die, die man stellt, wenn man zusieht.
 */

const NOW = new Date("2026-09-11T12:00:00Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let tokenId: string;
let strategyVersionId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  const [token] = await db
    .insert(tokens)
    .values({ mint: "So11111111111111111111111111111111111111112", decimals: 9, discoverySource: "test" })
    .returning();
  tokenId = token!.id;
  const [strategy] = await db.insert(strategies).values({ name: "dash" }).returning();
  const [version] = await db
    .insert(strategyVersions)
    .values({ strategyId: strategy!.id, version: "1.0.0", parameters: {}, reason: "Test" })
    .returning();
  strategyVersionId = version!.id;
});

afterEach(async () => {
  await close();
});

/** Eine Entscheidung, wie die Kette sie schreibt. */
async function entscheidung(input: {
  readonly kind: "ENTER" | "WATCH" | "REJECT";
  readonly finalScore: number | null;
  readonly rejectionReasons?: readonly string[];
  readonly minutes: number;
  readonly test?: boolean;
}): Promise<void> {
  const decidedAt = at(input.minutes * 60_000);
  const result = await new OpportunityRepository(db).create({
    tokenId,
    stream: "AUTO_PAPER",
    decisionKind: input.kind,
    finalScore: input.finalScore,
    reasons: [],
    risks: [],
    rejectionReasons: input.rejectionReasons ?? [],
    strategyVersionId,
    decidedAt,
    respondBy: null,
    provenance: {
      sourceType: input.test === true ? "TEST_FIXTURE" : "LIVE",
      sourceProvider: input.test === true ? "TEST_FIXTURE:dash" : "jupiter-quote",
      sourceTier: input.test === true ? null : "PRIMARY",
      sourceTimestamp: decidedAt,
      dataTimestamp: decidedAt,
      decisionTimestamp: decidedAt,
      dataQuality: 0.74,
    },
    snapshot: {
      tokenId,
      observedAt: decidedAt,
      features: {},
      missingFields: [],
      dataCompleteness: 0.74,
      scoreEngineVersion: "1.1.0",
      featureSetVersion: "1",
      inputHash: `hash-${String(input.minutes)}`,
    },
  });
  if (result.kind !== "CREATED") throw new Error("Fixture nicht angelegt");
}

describe("Entscheidungen im Dashboard", () => {
  it("meldet ohne Entscheidung eine leere Auszaehlung statt einer Null", async () => {
    const summary = await loadDecisionSummary(db, "PRODUCTION");
    expect(summary.total).toBe(0);
    // Ausdruecklich `null` und nicht 0: „nie einen Score gebildet" ist etwas
    // anderes als „bester Score war 0".
    expect(summary.bestScore).toBeNull();
  });

  it("zaehlt nach Art und nennt den besten Score", async () => {
    await entscheidung({ kind: "WATCH", finalScore: 70, minutes: 1 });
    await entscheidung({ kind: "WATCH", finalScore: 64, minutes: 2 });
    await entscheidung({ kind: "ENTER", finalScore: 81, minutes: 3 });

    const summary = await loadDecisionSummary(db, "PRODUCTION");
    expect(summary.byKind["WATCH"]).toBe(2);
    expect(summary.byKind["ENTER"]).toBe(1);
    expect(summary.total).toBe(3);
    // Die Zahl, an der sich ablesen laesst, WIE WEIT es noch ist.
    expect(summary.bestScore).toBe(81);
  });

  it("zaehlt nur den ERSTEN Ablehnungsgrund je Entscheidung", async () => {
    // Eine Ablehnung kann mehrere Gruende tragen. Alle zu zaehlen ergaebe eine
    // Summe, die groesser ist als die Zahl der Entscheidungen — und einen
    // Token, der mehrfach in der Liste steht.
    await entscheidung({
      kind: "REJECT",
      finalScore: 40,
      rejectionReasons: ["DATA_INCOMPLETE", "LIQUIDITY_TOO_LOW"],
      minutes: 4,
    });
    await entscheidung({
      kind: "REJECT",
      finalScore: 38,
      rejectionReasons: ["DATA_INCOMPLETE"],
      minutes: 5,
    });

    const summary = await loadDecisionSummary(db, "PRODUCTION");
    expect(summary.byReason["DATA_INCOMPLETE"]).toBe(2);
    expect(summary.byReason["LIQUIDITY_TOO_LOW"]).toBeUndefined();
    // Die Summe der Gruende uebersteigt die Zahl der Entscheidungen nicht.
    const summeGruende = Object.values(summary.byReason).reduce((a, b) => a + b, 0);
    expect(summeGruende).toBeLessThanOrEqual(summary.total);
  });

  it("laesst WATCH ohne Ablehnungsgrund", async () => {
    // WATCH ist ein Noch-nicht, kein Nein. Ein erfundener Grund liesse den
    // Betreiber ein Problem suchen, wo keines ist.
    await entscheidung({ kind: "WATCH", finalScore: 70, minutes: 6 });
    const summary = await loadDecisionSummary(db, "PRODUCTION");
    expect(Object.keys(summary.byReason)).toEqual([]);
  });

  it("haelt Fixture-Entscheidungen aus der Produktionszahl heraus", async () => {
    await entscheidung({ kind: "ENTER", finalScore: 90, minutes: 7, test: true });
    await entscheidung({ kind: "WATCH", finalScore: 70, minutes: 8 });

    const produktion = await loadDecisionSummary(db, "PRODUCTION");
    expect(produktion.total).toBe(1);
    // Der Fixture-Score von 90 darf hier NICHT als bester erscheinen.
    expect(produktion.bestScore).toBe(70);

    const test = await loadDecisionSummary(db, "TEST");
    expect(test.total).toBe(1);
    expect(test.bestScore).toBe(90);
  });

  it("schneidet auf ein Zeitfenster zu", async () => {
    await entscheidung({ kind: "WATCH", finalScore: 50, minutes: 1 });
    await entscheidung({ kind: "WATCH", finalScore: 72, minutes: 30 });

    const summary = await loadDecisionSummary(db, "PRODUCTION", at(20 * 60_000));
    expect(summary.total).toBe(1);
    expect(summary.bestScore).toBe(72);
  });
});
