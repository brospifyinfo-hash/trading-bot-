import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerId, tokenId as asTokenId, type ProviderId } from "@sae/core";
import { schema, type Database } from "@sae/db";
import type { KnownProviderId } from "@sae/config";
import type { MarketDataAdapter, MarketFields } from "@sae/pipeline";
import type { ProviderCapability, ProviderStatus } from "@sae/providers";

import { runOpportunityPipeline } from "../opportunity-pipeline";
import { createHarness, MINT, type Harness } from "./harness";

/**
 * Was passiert, wenn die Datenquelle nicht liefert.
 *
 * Die Adapter hier sind AUSFALL-Attrappen und ausdruecklich keine Anbieter: sie
 * liefern nie Marktdaten, sondern nur die Arten, auf die eine Abfrage scheitern
 * kann. Sie leben deshalb im Testordner und nicht im Produktionscode.
 *
 * Die eine Zusicherung, die alle Faelle teilen:
 * **LIVE_DATA_FAILURE_CANNOT_CREATE_VALID_SIGNAL** — keine Gelegenheit, keine
 * Position, kein Signal.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const CAPS: readonly ProviderCapability[] = ["TOKEN_MARKET"];

class UnavailableAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  async fetchMarket(): Promise<{ value: MarketFields; observedAt: Date } | null> {
    throw new Error("ECONNREFUSED");
  }
}

class TimeoutAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  async fetchMarket(): Promise<{ value: MarketFields; observedAt: Date } | null> {
    throw Object.assign(new Error("Zeit ueberschritten"), { errorCode: "ETIMEDOUT" });
  }
}

class MalformedAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  async fetchMarket(): Promise<{ value: MarketFields; observedAt: Date } | null> {
    // Antwort kam an, war aber nicht das, was der Vertrag verspricht.
    throw new Error("Schema-Validierung fehlgeschlagen: priceUsd ist kein number");
  }
}

class NoDataAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  async fetchMarket(): Promise<{ value: MarketFields; observedAt: Date } | null> {
    // Der Anbieter kennt den Token nicht. `null`, kein Ersatzwert.
    return null;
  }
}

class StaleAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  async fetchMarket(): Promise<{ value: MarketFields; observedAt: Date } | null> {
    return {
      value: {
        priceUsd: 0.0004,
        liquidityUsd: 120_000,
        marketCapUsd: null,
        volume24hUsd: null,
        volume5mUsd: null,
        buys5m: null,
        sells5m: null,
        priceImpactBps: null,
        exitCapacityRatio: null,
        holders: null,
      },
      // Zwei Stunden alt. Formal eine Antwort, fuer eine Einstiegsentscheidung
      // wertlos.
      observedAt: new Date(T0.getTime() - 7_200_000),
    };
  }
}

let h: Harness;
let db: Database;

beforeEach(async () => {
  h = await createHarness(T0);
  db = h.db;
});

afterEach(async () => {
  await h.close();
});

function liveRequest(input: {
  readonly adapter?: MarketDataAdapter;
  readonly status?: ProviderStatus;
  readonly configured?: boolean;
}) {
  const adapters = new Map<KnownProviderId, MarketDataAdapter>();
  if (input.adapter !== undefined) adapters.set("dexscreener", input.adapter);

  return {
    kind: "LIVE" as const,
    tokenId: asTokenId(h.tokenId),
    mint: MINT,
    adapters,
    statusOf: (): ProviderStatus => input.status ?? "CONNECTED",
    env:
      input.configured === false
        ? {}
        : { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
    allowDegraded: false,
  };
}

async function expectNothingWritten(): Promise<void> {
  expect(await db.select().from(schema.opportunities)).toHaveLength(0);
  expect(await db.select().from(schema.paperPositions)).toHaveLength(0);
  expect(await db.select().from(schema.featureSnapshots)).toHaveLength(0);
}

describe("LIVE_DATA_FAILURE_CANNOT_CREATE_VALID_SIGNAL", () => {
  it("Anbieter nicht erreichbar → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new UnavailableAdapter() }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("Anbieter vom Netz gesperrt → NO_SOURCE, nichts geschrieben", async () => {
    // BLOCKED ist nicht DOWN: der Anbieter antwortet nicht, weil das Netz
    // dazwischen steht. Fuer die Pipeline ist das Ergebnis dasselbe.
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new UnavailableAdapter(), status: "BLOCKED" }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("Zeitueberschreitung → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new TimeoutAdapter() }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("unlesbare Antwort → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new MalformedAdapter() }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("Anbieter kennt den Token nicht → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new NoDataAdapter() }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("leere Kette (kein Adapter) → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(liveRequest({}), h.deps());
    expect(result.kind).toBe("NO_SOURCE");
    if (result.kind === "NO_SOURCE") {
      expect(result.reason).toContain("Adapter-Modul");
    }
    await expectNothingWritten();
  });

  it("kein Anbieter konfiguriert → NO_SOURCE, nichts geschrieben", async () => {
    const result = await runOpportunityPipeline(
      liveRequest({ configured: false }),
      h.deps(),
    );
    expect(result.kind).toBe("NO_SOURCE");
    await expectNothingWritten();
  });

  it("veraltete Daten erzeugen kein Einstiegssignal", async () => {
    // Die Kette liefert etwas — aber zwei Stunden alt. Daraus darf keine
    // Einstiegsentscheidung entstehen.
    const result = await runOpportunityPipeline(
      liveRequest({ adapter: new StaleAdapter() }),
      h.deps(),
    );
    expect(result.kind === "NO_SOURCE" || result.kind === "BLOCKED").toBe(true);
    await expectNothingWritten();
  });
});

/**
 * Der Rueckfall, der im Log wie ein Datenproblem aussah.
 *
 * `resolveFromChain` fuehrt seine Versuche laengst mit — auf dem Erfolgspfad
 * wurden sie weggeworfen. Die Folge: faellt die Kette vom Router auf die
 * Marktdatenquelle zurueck, fehlen anschliessend Preiseinfluss und
 * Ausstiegsfaehigkeit, der Snapshot traegt keinen Zeitstempel, und die
 * Entscheidung endet drei Schritte spaeter mit `DATA_QUALITY_TOO_LOW`. Im Log
 * stand dann ein Datenurteil, obwohl die Auskunft lautet: der Router hat nicht
 * geantwortet.
 */
it("nennt die Quelle, die vor der liefernden nichts hergab", async () => {
  const { resolveMarketInput } = await import("../market-input");
  const { providerId, systemClock } = await import("@sae/core");

  const stumm: MarketDataAdapter = {
    providerId: providerId("jupiter-quote"),
    capabilities: ["TOKEN_MARKET"],
    fetchMarket: async () => null,
  };
  const liefernd: MarketDataAdapter = {
    providerId: providerId("dexscreener"),
    capabilities: ["TOKEN_MARKET"],
    fetchMarket: async () => ({
      value: {
        priceUsd: 0.00042, liquidityUsd: 180_000, marketCapUsd: 2_100_000,
        volume24hUsd: 95_000, volume5mUsd: 400, buys5m: 30, sells5m: 22,
        priceImpactBps: null, exitCapacityRatio: null, holders: null,
      },
      observedAt: null,
    }),
  };

  const result = await resolveMarketInput(
    {
      kind: "LIVE",
      tokenId: asTokenId("00000000-0000-4000-8000-000000000001"),
      mint: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      adapters: new Map<KnownProviderId, MarketDataAdapter>([
        ["jupiter-quote", stumm],
        ["dexscreener", liefernd],
      ]),
      statusOf: () => "CONNECTED",
      env: {
        DEXSCREENER_BASE_URL: "https://dexscreener.invalid",
        JUPITER_BASE_URL: "https://jupiter.invalid",
        SOLANA_RPC_URL: "https://rpc.invalid",
        MARKET_DATA_PRIORITY: "jupiter-quote,dexscreener",
      } as NodeJS.ProcessEnv,
      firstSeenAt: null,
      allowDegraded: false,
    },
    systemClock,
  );

  expect(result.kind).toBe("OK");
  if (result.kind !== "OK") return;
  // Der Kern: der stumme Router steht benannt im Ergebnis, nicht nur sein
  // Fehlen im Resultat.
  expect(result.fallbackFrom).toEqual(["jupiter-quote=NO_DATA"]);
  expect(result.provenance.sourceProvider).toBe("dexscreener");
});
