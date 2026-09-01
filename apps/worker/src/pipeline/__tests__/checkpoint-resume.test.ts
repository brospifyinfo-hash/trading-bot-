import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerId, type Clock, type ProviderId } from "@sae/core";
import { PostgresCheckpointStore, schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { createLogger } from "@sae/observability";
import type { MarketDataAdapter, MarketFields } from "@sae/pipeline";
import type { KnownProviderId } from "@sae/config";
import type { ProviderCapability, ProviderStatus } from "@sae/providers";

import { refreshMarketData, type MarketRefreshDeps } from "../market-refresh";

/**
 * Wiederaufnahme nach einem Absturz.
 *
 * Der Ablauf, den dieser Test nachstellt:
 *
 *   Worker startet → verarbeitet teilweise → Prozess weg
 *     → Worker startet erneut → setzt am Checkpoint fort
 *
 * Was dabei NICHT passieren darf: dass die bereits verarbeiteten Einheiten ein
 * zweites Mal abgefragt werden. Das kostet Rate-Limit-Budget, das beim
 * naechsten Ausfall fehlt — und erzeugt bei einem schreibenden Job doppelte
 * Ergebnisse.
 */

const T0 = new Date("2026-08-31T12:00:00Z");
const CAPS: readonly ProviderCapability[] = ["TOKEN_MARKET"];
const logger = createLogger({ service: "test", level: "error" });

class FixedClock implements Clock {
  constructor(private at: Date) {}
  now(): Date {
    return this.at;
  }
  advance(ms: number): void {
    this.at = new Date(this.at.getTime() + ms);
  }
}

/**
 * Zaehlt, wie oft jeder Mint abgefragt wurde.
 *
 * Ein AUSFALL-freier Adapter fuer den Nachweis der Wiederaufnahme — er liefert
 * denselben Datenpunkt und ist ausdruecklich kein Anbieter, sondern ein
 * Zaehlwerk fuer diesen Test.
 */
class CountingAdapter implements MarketDataAdapter {
  readonly providerId: ProviderId = providerId("dexscreener");
  readonly capabilities = CAPS;
  readonly calls: string[] = [];

  constructor(private readonly observedAt: Date) {}

  async fetchMarket(mint: string): Promise<{ value: MarketFields; observedAt: Date } | null> {
    this.calls.push(mint);
    return {
      value: {
        priceUsd: 0.0004 + this.calls.length / 1_000_000,
        liquidityUsd: 150_000,
        marketCapUsd: null,
        volume24hUsd: null,
        holders: null,
      },
      observedAt: this.observedAt,
    };
  }
}

let db: Database;
let close: () => Promise<void>;
let clock: FixedClock;
let adapter: CountingAdapter;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  clock = new FixedClock(T0);
  adapter = new CountingAdapter(T0);

  // Fuenf Tokens, damit sich Teilverarbeitung ueberhaupt zeigen kann.
  for (let i = 0; i < 5; i += 1) {
    await db
      .insert(schema.tokens)
      .values({ mint: `Mint${String(i).padStart(40, "0")}`, decimals: 9, discoverySource: "test" })
      .returning();
  }
});

afterEach(async () => {
  await close();
});

function deps(overrides: Partial<MarketRefreshDeps> = {}): MarketRefreshDeps {
  return {
    db,
    logger,
    env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
    clock,
    adapters: new Map<KnownProviderId, MarketDataAdapter>([["dexscreener", adapter]]),
    statusOf: (): ProviderStatus => "CONNECTED",
    maxUnitsPerRun: 2,
    maxTokens: 100,
    ...overrides,
  };
}

const JOB = "REFRESH_MARKET_DATA:fenster-1";

describe("Wiederaufnahme am Checkpoint", () => {
  it("setzt nach einem Abbruch dort fort, wo der Lauf endete", async () => {
    // Lauf 1: zwei von fuenf.
    const first = await refreshMarketData(JOB, deps());
    expect(first.processed).toBe(2);
    expect(first.completed).toBe(false);
    expect(adapter.calls).toHaveLength(2);

    // Der Prozess ist weg. Der Fortschritt steht in der Datenbank.
    const checkpoint = await new PostgresCheckpointStore(db).load(JOB);
    expect(checkpoint?.doneUnits).toHaveLength(2);
    expect(checkpoint?.totalUnits).toBe(5);

    // Lauf 2: neuer Prozess, derselbe Auftrag.
    const second = await refreshMarketData(JOB, deps());
    expect(second.processed).toBe(2);
    expect(second.skipped).toBe(2);
    // Und ganz wichtig: die ersten zwei wurden NICHT erneut abgefragt.
    expect(adapter.calls).toHaveLength(4);

    // Lauf 3: der Rest, danach ist der Auftrag fertig.
    const third = await refreshMarketData(JOB, deps());
    expect(third.processed).toBe(1);
    expect(third.skipped).toBe(4);
    expect(third.completed).toBe(true);
    expect(adapter.calls).toHaveLength(5);
  });

  it("loescht den Checkpoint nach vollstaendiger Abarbeitung", async () => {
    await refreshMarketData(JOB, deps({ maxUnitsPerRun: 100 }));
    // Sonst koennte derselbe Takt beim naechsten Fenster nichts mehr tun.
    expect(await new PostgresCheckpointStore(db).load(JOB)).toBeNull();
  });

  it("erzeugt keine doppelten Snapshots ueber mehrere Laeufe", async () => {
    await refreshMarketData(JOB, deps());
    await refreshMarketData(JOB, deps());
    await refreshMarketData(JOB, deps());

    const snapshots = await db.select().from(schema.tokenSnapshots);
    // Fuenf Tokens, ein Beobachtungszeitpunkt, ein Anbieter — fuenf Zeilen.
    expect(snapshots).toHaveLength(5);
    expect(new Set(snapshots.map((s) => s.ingestKey)).size).toBe(5);
  });

  it("erzeugt auch bei einem erneuten Lauf desselben Takts keine Duplikate", async () => {
    await refreshMarketData(JOB, deps({ maxUnitsPerRun: 100 }));
    // Der Checkpoint ist geloescht, also laeuft alles nochmal — aber die
    // Aufnahme selbst ist idempotent ueber UNIQUE (ingest_key).
    const zweiter = await refreshMarketData(JOB, deps({ maxUnitsPerRun: 100 }));
    expect(zweiter.ingested).toBe(0);
    expect(await db.select().from(schema.tokenSnapshots)).toHaveLength(5);
  });

  it("haelt getrennte Auftraege getrennt", async () => {
    await refreshMarketData("REFRESH_MARKET_DATA:fenster-1", deps());
    // Ein anderes Zeitfenster ist ein anderer Auftrag mit eigenem Fortschritt.
    const anderer = await refreshMarketData("REFRESH_MARKET_DATA:fenster-2", deps());
    expect(anderer.skipped).toBe(0);
    expect(anderer.processed).toBe(2);
  });

  it("meldet ohne Tokens einen abgeschlossenen Lauf statt eines Fehlers", async () => {
    await db.delete(schema.tokenSnapshots);
    await db.delete(schema.tokens);
    const result = await refreshMarketData(JOB, deps());
    expect(result.status).toBe("NO_TOKENS");
    expect(result.completed).toBe(true);
  });
});

describe("Ohne erreichbare Quelle entsteht kein Snapshot", () => {
  it("zaehlt NO_SOURCE und schreibt nichts", async () => {
    const result = await refreshMarketData(
      JOB,
      deps({ adapters: new Map(), maxUnitsPerRun: 100 }),
    );
    expect(result.ingested).toBe(0);
    expect(result.noSource).toBe(5);
    expect(await db.select().from(schema.tokenSnapshots)).toHaveLength(0);
  });
});
