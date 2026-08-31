import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../pit/__tests__/harness";
import { providerStatusSamples } from "../../schema/pipeline";
import { loadDashboardState, loadProviderStatus } from "../dashboard";

/**
 * Der Zustand, in dem sich dieses System gerade befindet — als Test.
 *
 * Kein Mock, keine erfundenen Kennzahlen: eine leere Datenbank, gegen die
 * dieselben Abfragen laufen wie im Betrieb. Was das Dashboard dann zeigt, ist
 * genau das, was es zeigen soll.
 */

let db: Database;
let close: () => Promise<void>;
const NOW = new Date("2026-08-31T12:00:00Z");

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
});

afterAll(async () => {
  await close();
});

describe("Leerer Zustand", () => {
  it("zeigt WAITING FOR LIVE MARKET DATA, keine Kennzahlen", async () => {
    const state = await loadDashboardState({ db, now: NOW });

    expect(state.headline).toBe("WAITING FOR LIVE MARKET DATA");
    expect(state.marketDataConnected).toBe(false);
    expect(state.ingestion.kind).toBe("WAITING");
    expect(state.paper.kind).toBe("WAITING");
    expect(state.opportunities.kind).toBe("WAITING");
    expect(state.research.kind).toBe("WAITING");
  });

  it("nennt die erste fehlende Voraussetzung, nicht die letzte", async () => {
    const state = await loadDashboardState({ db, now: NOW });
    // Ohne konfigurierte Quelle ist das die Quelle — nicht „zu wenige Trades".
    if (state.ingestion.kind === "WAITING") {
      expect(state.ingestion.reason).toMatch(/Marktdatenquelle/);
    }
    if (state.paper.kind === "WAITING") {
      expect(state.paper.reason).toMatch(/Marktdatenquelle/);
    }
  });

  it("hat keine Kachel, die eine Zahl ohne Daten zeigen koennte", async () => {
    const state = await loadDashboardState({ db, now: NOW });
    for (const panel of [state.ingestion, state.paper, state.opportunities, state.research]) {
      // Ein `value` gibt es nur im Fall DATA. Ein null waere in der Anzeige
      // irgendwann eine 0 geworden, und eine 0 sieht aus wie eine Messung.
      expect(panel.kind === "DATA" ? "value" in panel : !("value" in panel)).toBe(true);
    }
  });
});

describe("Provider-Status", () => {
  it("meldet gesperrte Quellen als solche", async () => {
    await db.insert(providerStatusSamples).values([
      {
        providerId: "dexscreener",
        kind: "market",
        status: "BLOCKED",
        capabilities: ["TOKEN_MARKET", "TOKEN_DISCOVERY"],
        observedAt: new Date(NOW.getTime() - 60_000),
        lastFailureAt: new Date(NOW.getTime() - 60_000),
        lastFailureReason: "CONNECT api.dexscreener.com:443 failed with 403",
        detail: "Verbindung wird vom Netz nicht zugelassen.",
      },
      {
        providerId: "birdeye",
        kind: "market",
        status: "NOT_CONFIGURED",
        capabilities: ["TOKEN_MARKET"],
        observedAt: new Date(NOW.getTime() - 60_000),
        detail: "Keine Zugangsdaten hinterlegt.",
      },
    ]);

    const state = await loadDashboardState({ db, now: NOW });
    expect(state.providers).toHaveLength(2);
    expect(state.marketDataConnected).toBe(false);
    if (state.ingestion.kind === "WAITING") {
      expect(state.ingestion.reason).toMatch(/gesperrt|verbunden/);
    }
  });

  it("nimmt je Provider die juengste Messung", async () => {
    await db.insert(providerStatusSamples).values({
      providerId: "dexscreener",
      kind: "market",
      status: "CONNECTED",
      capabilities: ["TOKEN_MARKET"],
      observedAt: NOW,
      lastSuccessAt: NOW,
      latencyMsP50: 120,
      latencyMsP95: 340,
      dataFreshnessSeconds: 8,
    });

    const rows = await loadProviderStatus(db);
    const dex = rows.find((r) => r.providerId === "dexscreener")!;
    expect(dex.status).toBe("CONNECTED");
    expect(dex.latencyMsP95).toBe(340);
    expect(dex.dataFreshnessSeconds).toBe(8);
  });

  it("erkennt eine verbundene Quelle im Gesamtbild", async () => {
    const state = await loadDashboardState({ db, now: NOW });
    expect(state.marketDataConnected).toBe(true);
    // Verbunden, aber noch keine Snapshots: die Historie wird aufgebaut.
    expect(state.headline).toBe("Historie wird aufgebaut.");
    expect(state.ingestion.kind).toBe("WAITING");
  });
});
