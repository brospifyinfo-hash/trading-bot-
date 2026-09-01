import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../client";
import { createTestDatabase } from "../../testing/harness";
import { ProviderReadinessStore } from "../../stores/provider-readiness";
import { loadDiagnostics } from "../diagnostics";

/**
 * Der Diagnose-Endpunkt.
 *
 * Er soll nach einem Deployment ohne Kenntnis des Codes beantworten: kommt
 * dieses System an Daten, und wenn nein, woran haengt es? Geprueft wird vor
 * allem, dass er nicht schoenfaerbt — eine leere Messung ist `null`, keine
 * Null, und eine Sperre heisst BLOCKED und nicht „warten".
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

describe("Ohne konfigurierten Anbieter", () => {
  it("meldet NO PROVIDER CONFIGURED", async () => {
    const report = await loadDiagnostics({ db, now: T0 });
    expect(report.headline).toBe("NO PROVIDER CONFIGURED");
    expect(report.anyProductionVerified).toBe(false);
    expect(report.providers).toHaveLength(0);
    expect(report.chains).toHaveLength(0);
  });
});

describe("Konfiguriert, aber ohne Kontakt", () => {
  beforeEach(async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });
  });

  it("meldet WAITING FOR PROVIDER und keine erfundene Fehlerquote", async () => {
    const report = await loadDiagnostics({ db, now: T0 });
    expect(report.headline).toBe("WAITING FOR PROVIDER");

    const provider = report.providers[0];
    expect(provider?.productionVerified).toBe(false);
    expect(provider?.lastSuccessAt).toBeNull();
    expect(provider?.requestsLastHour).toBe(0);
    // Eine Fehlerquote von 0 ohne Anfragen waere eine Aussage ueber nichts.
    expect(provider?.errorRateLastHour).toBeNull();
    expect(provider?.schemaValidated).toBeNull();
  });

  it("zeigt die Kette mit ihrem Mitglied, aber ohne Bereitschaft", async () => {
    const report = await loadDiagnostics({ db, now: T0 });
    const chain = report.chains[0];
    expect(chain?.capability).toBe("TOKEN_MARKET");
    expect(chain?.members.map((m) => m.providerId)).toEqual(["dexscreener"]);
    expect(chain?.ready).toHaveLength(0);
  });
});

describe("Gesperrt", () => {
  it("meldet BLOCKED und nennt die Sperre als solche", async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });
    await store.recordRequest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      endpoint: "/tokens/v1/solana/{address}",
      at: at(1_000),
      latencyMs: 120,
      httpStatus: 403,
      success: false,
      failureClass: "BLOCKED",
      failureReason: "Host not in allowlist",
    });
    await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 403,
      detail: "Host not in allowlist",
      schemaVerified: false,
    });

    const report = await loadDiagnostics({ db, now: at(2_000) });
    expect(report.headline).toBe("BLOCKED");

    const provider = report.providers[0];
    expect(provider?.state).toBe("BLOCKED");
    expect(provider?.lastFailureClass).toBe("BLOCKED");
    expect(provider?.lastFailureReason).toContain("allowlist");
    expect(provider?.lastSmokeTestStatus).toBe(403);
    expect(provider?.errorRateLastHour).toBe(1);

    // Die Kette sagt, warum Warten nicht hilft.
    expect(report.chains[0]?.note).toContain("Sperre");
  });
});

describe("Verifiziert", () => {
  it("meldet PROVIDER VERIFIED mit letzter erfolgreicher Antwort", async () => {
    await store.declare({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      implementationConfidence: "SCHEMA_KNOWN",
    });
    await store.recordRequest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      endpoint: "/tokens/v1/solana/{address}",
      at: at(1_000),
      latencyMs: 143,
      httpStatus: 200,
      success: true,
      schemaValid: true,
      tokensCovered: 30,
    });
    await store.recordSmokeTest({
      providerId: "dexscreener",
      capability: "TOKEN_MARKET",
      at: at(1_000),
      httpStatus: 200,
      detail: "30 Paare, Schema validiert",
      schemaVerified: true,
    });

    const report = await loadDiagnostics({ db, now: at(2_000) });
    expect(report.headline).toBe("PROVIDER VERIFIED");
    expect(report.anyProductionVerified).toBe(true);

    const provider = report.providers[0];
    expect(provider?.state).toBe("CAPABILITY_READY");
    expect(provider?.lastSuccessLatencyMs).toBe(143);
    expect(provider?.schemaValidated).toBe(true);
    expect(provider?.errorRateLastHour).toBe(0);

    expect(report.chains[0]?.ready).toEqual(["dexscreener"]);
  });

  it("fuehrt Faehigkeiten desselben Anbieters in getrennten Ketten", async () => {
    for (const capability of ["TOKEN_MARKET", "SMART_MONEY"]) {
      await store.declare({
        providerId: "birdeye",
        capability,
        implementationConfidence: "SHAPE_ONLY",
      });
    }
    const report = await loadDiagnostics({ db, now: T0 });
    expect(report.chains.map((c) => c.capability).sort()).toEqual(["SMART_MONEY", "TOKEN_MARKET"]);
  });
});
