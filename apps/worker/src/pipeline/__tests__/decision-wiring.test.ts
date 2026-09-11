import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { ensureActiveStrategyVersion, schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import { providerId } from "@sae/core";
import type { MarketDataAdapter } from "@sae/pipeline";

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

/**
 * Eine Quelle, die tatsaechlich etwas liefert.
 *
 * Ohne Beobachtungszeitpunkt — wie DexScreener. Das reicht fuer diesen Test:
 * geprueft wird, ob die Kette ueberhaupt angeschlossen ist, nicht ob die Daten
 * eine Einstiegsentscheidung tragen.
 */
function arbeitenderAdapter(): MarketDataAdapter {
  return {
    providerId: providerId("dexscreener"),
    capabilities: ["TOKEN_MARKET"],
    async fetchMarket() {
      return {
        value: {
          priceUsd: 0.00042,
          liquidityUsd: 180_000,
          marketCapUsd: 2_100_000,
          volume24hUsd: 95_000,
          volume5mUsd: 400,
          buys5m: 30,
          sells5m: 22,
          priceImpactBps: null,
          exitCapacityRatio: null,
          holders: null,
        },
        observedAt: null,
      };
    },
  };
}

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

  /**
   * Der Test, der gefehlt hat — und der Grund, warum er gefehlt hat.
   *
   * Der Test darueber erwartet `NO_SOURCE` und war die ganze Zeit gruen. Er
   * konnte den Fehler nicht finden, weil er dieselbe Leere herstellte, die der
   * Fehler erzeugte: kein Adapter, jeder Anbieter `UNAVAILABLE`. Unter diesen
   * Bedingungen ist `NO_SOURCE` richtig — und es blieb auch dann richtig, als
   * `runDecision` intern `adapters: new Map()` fest verdrahtet hatte.
   *
   * Ein Test, der die Bedingung mitliefert, unter der ein Fehler unsichtbar
   * ist, prueft nichts. Dieser hier gibt der Kette eine ARBEITENDE Quelle und
   * verlangt, dass sie am Marktdaten-Tor vorbeikommt.
   */
  it("kommt mit erreichbarem Anbieter am Marktdaten-Tor vorbei", async () => {
    const registry = buildHandlers({
      db,
      logger,
      env: {
        DATABASE_URL: "postgres://test",
        DEXSCREENER_BASE_URL: "https://api.example.invalid",
      } as NodeJS.ProcessEnv,
      adapters: new Map([["dexscreener", arbeitenderAdapter()]]),
      statusOf: () => "CONNECTED",
    });

    const result = (await registry["EVALUATE_OPPORTUNITY"]?.handle(job)) as {
      status: string;
      outcomes: Record<string, number>;
    };

    // NICHT mehr NO_SOURCE: die Kette hat Marktdaten bekommen.
    expect(result.outcomes["NO_SOURCE"]).toBeUndefined();
    // Sie kommt bis zum naechsten ehrlichen Halt: der Feature-Vektor braucht
    // Historie, und die gibt es in dieser leeren Testdatenbank nicht.
    expect(result.outcomes["BLOCKED"]).toBe(1);
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
