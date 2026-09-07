import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { ensureActiveStrategyVersion, schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";

import { buildHandlers } from "../../handlers";

/**
 * Die Verdrahtung, die drei Tage lang gefehlt hat.
 *
 * `runOpportunityPipeline` war gebaut und getestet und wurde ausschliesslich
 * aus Tests aufgerufen. Der Auftrag `EVALUATE_OPPORTUNITY` zeigte auf den
 * allgemeinen Marktdaten-Handler, der Daten holte und wegwarf.
 *
 * Geprueft wird deshalb nicht, dass eine Position entsteht — sie entsteht
 * heute zu Recht nicht. Geprueft wird, dass die Kette LAEUFT und dass am Ende
 * ein benannter Grund steht statt Schweigen.
 */

const T0 = new Date("2026-09-07T18:00:00Z");
const logger = createLogger({ service: "test", level: "error" });
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

const job = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "EVALUATE_OPPORTUNITY",
  payload: {},
  dedupeKey: "job:evaluate:test",
  attempts: 1,
  maxAttempts: 3,
  enqueuedAt: T0,
};

function handlers() {
  return buildHandlers({
    db,
    logger,
    env: { DATABASE_URL: "postgres://test" } as NodeJS.ProcessEnv,
    statusOf: () => "UNAVAILABLE",
  });
}

describe("Strategieversion", () => {
  it("legt beim ersten Mal eine an", async () => {
    const first = await ensureActiveStrategyVersion({
      db,
      parameters: DEFAULT_STRATEGY_PARAMETERS,
      at: T0,
    });
    expect(first.created).toBe(true);
    expect(first.version).toBe("0.1.0");
  });

  it("legt beim zweiten Mal KEINE zweite an", async () => {
    // Sonst zerfiele die Statistik in Versionen, die sich in nichts
    // unterscheiden — bei jedem Neustart eine mehr.
    const second = await ensureActiveStrategyVersion({
      db,
      parameters: DEFAULT_STRATEGY_PARAMETERS,
      at: T0,
    });
    expect(second.created).toBe(false);

    const alle = await db.select({ id: schema.strategyVersions.id }).from(schema.strategyVersions);
    expect(alle).toHaveLength(1);
  });

  it("haelt fest, womit gerechnet wird, ohne es gutzuheissen", async () => {
    const [row] = await db
      .select({ reason: schema.strategyVersions.reason })
      .from(schema.strategyVersions)
      .limit(1);
    expect(row?.reason).toContain("nicht validiert");
  });
});

describe("Gelegenheitspruefung", () => {
  it("meldet ohne beobachtete Tokens, dass es nichts zu pruefen gibt", async () => {
    const result = await handlers()["EVALUATE_OPPORTUNITY"]?.handle(job);
    expect(result).toMatchObject({ status: "NO_SOURCE" });
  });

  it("laeuft die Kette und nennt den Grund, statt zu schweigen", async () => {
    await db
      .insert(schema.tokens)
      .values({ mint: MEME, discoverySource: "dexscreener", state: "SCREENING" });

    const result = (await handlers()["EVALUATE_OPPORTUNITY"]?.handle(job)) as {
      status: string;
      processed: number;
      outcomes: Record<string, number>;
    };

    expect(result.status).toBe("OK");
    expect(result.processed).toBe(1);
    // Der Kern: es gibt ein benanntes Ergebnis. Vorher passierte nichts und
    // niemand erfuhr warum. Ohne erreichbaren Anbieter ist NO_SOURCE die
    // richtige Auskunft — und sie steht jetzt da.
    expect(Object.keys(result.outcomes)).toHaveLength(1);
    expect(result.outcomes["NO_SOURCE"]).toBe(1);
  });

  it("legt keine Gelegenheit und keine Position an", async () => {
    // Der Lauf darf nichts erzeugen, solange die Datenlage keine Entscheidung
    // traegt. Er soll sichtbar machen, nicht handeln.
    const opportunities = await db.select({ id: schema.opportunities.id }).from(schema.opportunities);
    const positions = await db.select({ id: schema.paperPositions.id }).from(schema.paperPositions);
    expect(opportunities).toHaveLength(0);
    expect(positions).toHaveLength(0);
  });
});
