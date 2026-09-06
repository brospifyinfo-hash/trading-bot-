import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  missing,
  mint as toMint,
  observed,
  providerId,
  type Clock,
  type Maybe,
  type Mint,
} from "@sae/core";
import type { DiscoveredToken, DiscoverySource, TokenAuthorities } from "@sae/discovery";
import { schema, type ClaimedJob, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import type { ProviderStatus } from "@sae/providers";

import { buildHandlers } from "../../handlers";
import { buildDiscoverySources, runTokenDiscovery } from "../discovery-run";

/**
 * Der Lauf, der den Bot Tokens finden laesst.
 *
 * Geprueft wird der Weg von der Quelle bis zur Zeile in `tokens` — also genau
 * das Stueck, das bisher fehlte. Die Quellen sind hier Fixtures und keine
 * nachgebauten Anbieter: sie beantworten die Frage „was macht der Lauf mit
 * dem, was ankommt", nicht die Frage „antwortet DexScreener". Letztere
 * beantwortet `discovery-source.test.ts` gegen eine echte Antwortform.
 */

const T0 = new Date("2026-09-06T09:00:00Z");
const clock: Clock = { now: () => T0 };
const logger = createLogger({ service: "test", level: "error" });
const SOURCE = providerId("dexscreener");

const DICK = "33LZGLLvtRDx3uAfJ1CcBSC7pNFqdiCBAvwPsVkBpump";
const DUENN = "GSBZLSX8R8nq9qp2fs5oaLcQS72aG1SFEyuqbS1Apump";
const GEPRAEGT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});
afterAll(async () => {
  await close();
});

function token(mint: string, liquidityUsd: number | null, symbol: string): DiscoveredToken {
  return {
    mint: toMint(mint),
    trigger: "NEW_LAUNCH",
    source: SOURCE,
    observedAt: T0,
    // Sechs Stunden alt — ueber der Altersgrenze des Vorsiebs.
    launchedAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    symbol,
    poolAddress: null,
    liquidityUsd:
      liquidityUsd === null
        ? missing("NOT_SUPPORTED_BY_PROVIDER", T0, SOURCE)
        : observed(liquidityUsd, SOURCE, T0),
    marketCapUsd: observed(2_000_000, SOURCE, T0),
  };
}

function sourceOf(tokens: readonly DiscoveredToken[]): DiscoverySource {
  return {
    id: SOURCE,
    trigger: "NEW_LAUNCH",
    discover: async (): Promise<Maybe<readonly DiscoveredToken[]>> => observed(tokens, SOURCE, T0),
  };
}

const failingSource: DiscoverySource = {
  id: SOURCE,
  trigger: "NEW_LAUNCH",
  discover: async () => missing("PROVIDER_RATE_LIMITED", T0, SOURCE),
};

function deps(over: Partial<Parameters<typeof runTokenDiscovery>[0]> = {}) {
  return {
    db,
    logger,
    clock,
    env: {} as NodeJS.ProcessEnv,
    statusOf: (): ProviderStatus => "CONNECTED",
    ...over,
  };
}

async function stateOf(mint: string): Promise<string | undefined> {
  const [row] = await db
    .select({ state: schema.tokens.state })
    .from(schema.tokens)
    .where(eq(schema.tokens.mint, mint))
    .limit(1);
  return row?.state;
}

describe("Discovery-Lauf", () => {
  it("legt gefundene Tokens an und trennt Kandidaten von Beobachtung", async () => {
    const result = await runTokenDiscovery(
      deps({
        // Ein Token ueber der Vorsieb-Schwelle, einer darunter. Die Schwelle
        // ist die Haelfte des Einstiegsgates — das Sieb soll grob sein.
        sources: [sourceOf([token(DICK, 180_000, "DICK"), token(DUENN, 5_000, "DUENN")])],
      }),
    );

    expect(result.status).toBe("OK");
    expect(result.seen).toBe(2);
    expect(result.fresh).toBe(2);
    expect(result.candidates).toBe(1);
    expect(result.watchlist).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.failedSources).toEqual([]);

    expect(await stateOf(DICK)).toBe("SCREENING");
    // Der duenne Token verschwindet NICHT: er ist spaeter die Kontrollgruppe.
    expect(await stateOf(DUENN)).toBe("WATCHLIST");

    const [row] = await db
      .select({ source: schema.tokens.discoverySource, symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.mint, DICK))
      .limit(1);
    expect(row?.source).toBe("dexscreener");
    expect(row?.symbol).toBe("DICK");
  });

  it("meldet den zweiten Lauf als Dubletten und laesst die Zustaende stehen", async () => {
    const result = await runTokenDiscovery(
      deps({ sources: [sourceOf([token(DICK, 180_000, "DICK"), token(DUENN, 5_000, "DUENN")])] }),
    );

    expect(result.fresh).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.candidates).toBe(0);
    // Ohne Deduplizierung liefe die teure Anreicherung bei jedem Takt erneut.
    expect(await stateOf(DICK)).toBe("SCREENING");
    expect(await stateOf(DUENN)).toBe("WATCHLIST");
  });

  it("zaehlt die fehlende Autoritaetspruefung, statt sie zu verschweigen", async () => {
    // Ohne Lesemodul fuer den Mint-Account sind Mint- und Freeze-Authority
    // unbekannt, und `cheapScreen` lehnt bei Unbekanntem nicht ab. Das ist
    // eine echte Abschwaechung des Siebs — sie muss zaehlbar sein.
    const result = await runTokenDiscovery(
      deps({ sources: [sourceOf([token(GEPRAEGT, 180_000, "NEU")])] }),
    );
    expect(result.withoutAuthorityCheck).toBe(1);
    expect(result.candidates).toBe(1);
  });

  it("schreibt einen endgueltig abgelehnten Token als REJECTED fest", async () => {
    const MINT = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";
    const active: TokenAuthorities = {
      mintAuthorityActive: observed(true, SOURCE, T0),
      freezeAuthorityActive: observed(false, SOURCE, T0),
    };

    const result = await runTokenDiscovery(
      deps({
        sources: [sourceOf([token(MINT, 180_000, "PRAEGBAR")])],
        checkAuthorities: async (_mint: Mint): Promise<TokenAuthorities> => active,
      }),
    );

    expect(result.rejected).toBe(1);
    expect(result.candidates).toBe(0);
    expect(result.watchlist).toBe(0);
    // Mit Lesemodul ist die Luecke geschlossen — der Zaehler bleibt bei null.
    expect(result.withoutAuthorityCheck).toBe(0);
    expect(result.reasons["MINT_AUTHORITY_ACTIVE"]).toBe(1);
    // Die Zeile bleibt bestehen: was das System gesehen hat, soll es wissen,
    // sonst findet es denselben Token bei jedem Takt erneut.
    expect(await stateOf(MINT)).toBe("REJECTED");
  });

  it("benennt eine ausgefallene Quelle und legt nichts an", async () => {
    const vorher = await db.select({ id: schema.tokens.id }).from(schema.tokens);
    const result = await runTokenDiscovery(deps({ sources: [failingSource] }));

    expect(result.status).toBe("OK");
    expect(result.seen).toBe(0);
    expect(result.fresh).toBe(0);
    // Der Grund steht dran: gedrosselt ist nicht dasselbe wie tot.
    expect(result.failedSources).toEqual(["dexscreener:PROVIDER_RATE_LIMITED"]);

    const nachher = await db.select({ id: schema.tokens.id }).from(schema.tokens);
    expect(nachher).toHaveLength(vorher.length);
  });

  it("meldet NO_SOURCE, wenn es keine nutzbare Quelle gibt", async () => {
    const result = await runTokenDiscovery(deps({ sources: [] }));
    expect(result.status).toBe("NO_SOURCE");
    expect(result.seen).toBe(0);
  });
});

describe("Auswahl der Quellen", () => {
  const env = { DEXSCREENER_BASE_URL: "https://api.example.invalid" } as NodeJS.ProcessEnv;

  it("nimmt einen konfigurierten und erreichbaren Anbieter", () => {
    const sources = buildDiscoverySources({ env, clock, statusOf: () => "CONNECTED" });
    expect(sources.map((s) => String(s.id))).toEqual(["dexscreener"]);
  });

  it("fragt einen Anbieter nicht, der nachweislich nicht antwortet", () => {
    // Der Zustand stammt aus der PERSISTIERTEN Messung. Einen als
    // nicht erreichbar gemessenen Anbieter zu fragen erzeugt nur Fehler, die
    // wie Datenprobleme aussehen.
    for (const status of ["UNAVAILABLE", "BLOCKED", "NOT_CONFIGURED"] as const) {
      expect(buildDiscoverySources({ env, clock, statusOf: () => status })).toEqual([]);
    }
  });

  it("nimmt einen eingeschraenkten Anbieter — fuer das Finden reicht er", () => {
    // DEGRADED reicht zum Finden; fuer eine EINSTIEGSENTSCHEIDUNG reicht es
    // ausdruecklich nicht, und darueber entscheidet nicht diese Stelle.
    const sources = buildDiscoverySources({ env, clock, statusOf: () => "DEGRADED" });
    expect(sources).toHaveLength(1);
  });

  it("nimmt keinen unkonfigurierten Anbieter", () => {
    const sources = buildDiscoverySources({
      env: {} as NodeJS.ProcessEnv,
      clock,
      statusOf: () => "CONNECTED",
    });
    expect(sources).toEqual([]);
  });
});

describe("Verdrahtung des Auftrags", () => {
  const job: ClaimedJob = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "DISCOVER_TOKENS",
    // Der Auftrag traegt KEINEN Mint — er ist der, der Mints erzeugt. Genau
    // daran scheiterte er vorher: der generische Marktdaten-Handler suchte
    // einen Token im Auftrag, fand keinen und meldete NO_SOURCE.
    payload: {},
    dedupeKey: "job:discover:test",
    attempts: 1,
    maxAttempts: 3,
    enqueuedAt: T0,
  };

  it("fuehrt DISCOVER_TOKENS in den Discovery-Lauf und nicht in die Marktdaten", async () => {
    const handlers = buildHandlers({
      db,
      logger,
      env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" } as NodeJS.ProcessEnv,
      statusOf: () => "UNAVAILABLE",
    });

    const result = await handlers["DISCOVER_TOKENS"]?.handle(job);
    // Die Antwortform des Discovery-Laufs, nicht die von `waitingForData`:
    // ein `reason`-Feld gaebe es nur im alten Pfad.
    expect(result).toMatchObject({ status: "NO_SOURCE", seen: 0, candidates: 0 });
    expect(result).not.toHaveProperty("reason");
  });
});
