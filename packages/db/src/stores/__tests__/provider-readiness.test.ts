import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { providerCapabilityStatus } from "../../schema/provider-readiness";
import { ProviderReadinessStore } from "../provider-readiness";

/**
 * Reifegrad je Faehigkeit.
 *
 * Die Zusicherung, um die es hier geht: **ein Fixture kann keinen Anbieter als
 * produktionsbereit markieren.** Nicht weil ein Filter es abfaengt, sondern
 * weil `production_verified` einen HTTP-Status im Erfolgsbereich verlangt — und
 * ein Testlauf hat keinen.
 */

const T0 = new Date("2026-09-01T12:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let db: Database;
let close: () => Promise<void>;
let store: ProviderReadinessStore;

beforeEach(async () => {
  ({ db, close } = await createTestDatabase());
  store = new ProviderReadinessStore(db);
});

afterEach(async () => {
  await close();
});

describe("Ausgangszustand", () => {
  it("meldet einen konfigurierten Anbieter als CONFIGURED, nicht als verbunden", async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });

    const status = await store.statusOf("dexscreener", "TOKEN_MARKET");
    expect(status?.state).toBe("CONFIGURED");
    // Eine Basis-URL in der Konfiguration heisst nicht, dass je eine Antwort kam.
    expect(status?.productionVerified).toBe(false);
    expect(status?.lastSmokeTestAt).toBeNull();
  });

  it("aktualisiert den Reifegrad, ohne den Zustand zu ueberspringen", async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SHAPE_ONLY",
    });
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });

    const status = await store.statusOf("dexscreener", "TOKEN_MARKET");
    expect(status?.implementationConfidence).toBe("SCHEMA_KNOWN");
    expect(status?.state).toBe("CONFIGURED");
  });

  it("fuehrt Faehigkeiten desselben Anbieters getrennt", async () => {
    // Birdeye kann fuer TOKEN_MARKET bereit sein und fuer SMART_MONEY nicht.
    await store.declare({
      providerId: "birdeye",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SHAPE_ONLY",
    });
    await store.declare({
      providerId: "birdeye",
      capability: "SMART_MONEY",
      implementationConfidence: "NONE",
    });

    expect((await store.statusOf("birdeye", "TOKEN_MARKET"))?.implementationConfidence).toBe(
      "SHAPE_ONLY",
    );
    expect((await store.statusOf("birdeye", "SMART_MONEY"))?.implementationConfidence).toBe("NONE");
  });
});

describe("PRODUCTION_VERIFIED nur nach echtem Request", () => {
  beforeEach(async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });
  });

  it("setzt es nach einem erfolgreichen Smoke-Test mit geprueftem Schema", async () => {
    const result = await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 200,
      detail: "1 Paar, Schema validiert",
      schemaVerified: true,
    });

    expect(result?.productionVerified).toBe(true);
    expect(result?.state).toBe("CAPABILITY_READY");
    expect(result?.implementationConfidence).toBe("SCHEMA_VERIFIED");
  });

  it("setzt es NICHT bei einem Fehlschlag", async () => {
    const result = await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 403,
      detail: "Egress-Proxy verweigert",
      schemaVerified: false,
    });

    expect(result?.productionVerified).toBe(false);
    // Ein 403 kann vom Anbieter kommen oder von einem Proxy dazwischen. Von
    // hier aus ist das nicht unterscheidbar, also wird nichts befoerdert.
    expect(result?.state).toBe("CONFIGURED");
    expect(result?.lastSmokeTestStatus).toBe(403);
  });

  it("erreicht ohne geprueftes Schema kein CAPABILITY_READY", async () => {
    // Ein 200er allein reicht nicht: ohne bekannten Vertrag weiss niemand, ob
    // die Antwort das enthielt, was wir glauben.
    const result = await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 200,
      detail: "Antwort kam, Schema unbekannt",
      schemaVerified: false,
    });
    expect(result?.state).toBe("CONNECTED");
  });

  it("laesst sich per direktem Schreibzugriff nicht faelschen", async () => {
    // Die Repositories umgangen: die CHECK-Constraint haelt trotzdem.
    await expect(
      db
        .update(providerCapabilityStatus)
        .set({ productionVerified: true })
        .where(eq(providerCapabilityStatus.providerId, "dexscreener")),
    ).rejects.toThrow();
  });

  it("laesst PRODUCTION_ENABLED ohne Verifikation nicht zu", async () => {
    await expect(
      db
        .update(providerCapabilityStatus)
        .set({ state: "PRODUCTION_ENABLED" })
        .where(eq(providerCapabilityStatus.providerId, "dexscreener")),
    ).rejects.toThrow();
  });

  it("nimmt nur verifizierte Anbieter in die Bereitschaftsliste", async () => {
    expect(await store.ready("TOKEN_MARKET")).toHaveLength(0);

    await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 200,
      detail: "ok",
      schemaVerified: true,
    });

    expect(await store.ready("TOKEN_MARKET")).toEqual(["dexscreener"]);
  });
});

describe("Messung echter Requests", () => {
  it("haelt Latenz, Fehlerquote und Schemafehler getrennt", async () => {
    const base = {
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      endpoint: "/tokens/v1/solana/{address}",
      pipelineStage: "MARKET_FILTER",
    };

    await store.recordRequest({
      ...base,
      at: at(1_000),
      latencyMs: 120,
      httpStatus: 200,
      success: true,
      schemaValid: true,
      tokensCovered: 30,
    });
    await store.recordRequest({
      ...base,
      at: at(2_000),
      latencyMs: 900,
      httpStatus: 200,
      success: true,
      schemaValid: false,
      tokensCovered: 30,
    });
    await store.recordRequest({
      ...base,
      at: at(3_000),
      latencyMs: 5_000,
      httpStatus: 429,
      success: false,
      failureClass: "RATE_LIMITED",
      failureReason: "429 Too Many Requests",
      tokensCovered: 1,
    });

    const [m] = await store.measurements(T0);
    expect(m?.requests).toBe(3);
    expect(m?.errorRate).toBeCloseTo(1 / 3, 5);
    expect(m?.schemaFailures).toBe(1);
    // Bulk zaehlt: 61 Tokens aus drei Aufrufen.
    expect(m?.tokensCovered).toBe(61);
    // Perzentile statt Mittelwert: der 5-Sekunden-Aufruf bleibt sichtbar.
    expect(m?.latencyP95).toBeGreaterThan(900);
  });

  it("verlangt bei einem Fehlschlag eine Begruendung", async () => {
    await expect(
      store.recordRequest({
        providerId: "dexscreener",
        capability: "TOKEN_MARKET",
        endpoint: "/x",
        at: at(1_000),
        latencyMs: 10,
        httpStatus: 500,
        success: false,
      }),
    ).rejects.toThrow();
  });
});
