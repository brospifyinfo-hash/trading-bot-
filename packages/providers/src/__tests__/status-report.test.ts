import { describe, expect, it } from "vitest";
import { FixedClock, providerId } from "@sae/core";

import { ProviderRecorder, summarizeFleet } from "../status-report";
import type { ProviderStatusReport } from "../capability";

const T0 = new Date("2026-08-31T12:00:00Z");

function recorder(configured = true, clock = new FixedClock(T0)) {
  return new ProviderRecorder({
    providerId: providerId("dexscreener"),
    kind: "market",
    capabilities: ["TOKEN_MARKET", "TOKEN_DISCOVERY"],
    clock,
    configured,
  });
}

describe("Statusbericht je Provider", () => {
  it("meldet einen nicht konfigurierten Anbieter als solchen", () => {
    const report = recorder(false).report();
    expect(report.status).toBe("NOT_CONFIGURED");
    expect(report.detail).toMatch(/Keine Zugangsdaten/);
  });

  it("haelt Erfolg, Fehlschlag und Grund getrennt fest", () => {
    const clock = new FixedClock(T0);
    const r = recorder(true, clock);

    r.recordSuccess({ latencyMs: 120, observedAt: new Date(T0.getTime() - 10_000) });
    clock.advance(1_000);
    r.recordFailure({ httpStatus: 503, message: "upstream down" });

    const report = r.report();
    expect(report.lastSuccessAt).not.toBeNull();
    expect(report.lastFailureAt).not.toBeNull();
    // Ein Erfolg loescht die Fehlerhistorie nicht.
    expect(report.lastFailureReason).toBe("upstream down");
  });

  it("meldet eine Netzsperre als BLOCKED, nicht als ausgefallen", () => {
    const r = recorder();
    r.recordFailure({ message: "CONNECT api.jup.ag:443 failed with 403 Forbidden" });
    const report = r.report();

    expect(report.status).toBe("BLOCKED");
    expect(report.detail).toMatch(/403/);
  });

  it("misst die Frische an den Daten, nicht am Abruf", () => {
    const clock = new FixedClock(T0);
    const r = recorder(true, clock);
    r.recordSuccess({ latencyMs: 50, observedAt: new Date(T0.getTime() - 30_000) });
    clock.advance(15_000);

    // 30 s alt beim Abruf, 15 s spaeter gefragt: 45 s.
    expect(r.report().dataFreshnessSeconds).toBe(45);
  });

  it("laesst die Frische unbekannt, wenn der Anbieter keinen Zeitstempel liefert", () => {
    // „Gerade geholt" ist nicht dasselbe wie „gerade entstanden".
    const r = recorder();
    r.recordSuccess({ latencyMs: 50 });
    expect(r.report().dataFreshnessSeconds).toBeNull();
  });

  it("gibt Latenz als zwei Perzentile aus", () => {
    const r = recorder();
    for (const ms of [50, 60, 70, 80, 900]) r.recordSuccess({ latencyMs: ms });
    expect(r.report().latencyMsP50!).toBeLessThan(r.report().latencyMsP95!);
    expect(r.report().latencyMsP95).toBe(900);
  });

  it("fuehrt den Rate-Limit-Stand mit, wenn der Anbieter ihn meldet", () => {
    const r = recorder();
    r.recordSuccess({
      latencyMs: 40,
      rateLimit: { remaining: 12, limit: 60, resetAt: new Date(T0.getTime() + 30_000), localTokensAvailable: null },
    });
    expect(r.report().rateLimit).toMatchObject({ remaining: 12, limit: 60 });
  });

  it("nennt die Fähigkeiten des Anbieters", () => {
    expect(recorder().report().capabilities).toEqual(["TOKEN_MARKET", "TOKEN_DISCOVERY"]);
  });
});

describe("Flottenstatus", () => {
  function report(
    id: string,
    status: ProviderStatusReport["status"],
    capabilities: ProviderStatusReport["capabilities"] = ["TOKEN_MARKET"],
  ): ProviderStatusReport {
    return {
      providerId: providerId(id),
      kind: "market",
      status,
      capabilities,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      latencyMsP50: null,
      latencyMsP95: null,
      rateLimit: null,
      dataFreshnessSeconds: null,
      detail: null,
    };
  }

  it("erkennt, dass keine Marktdatenquelle verbunden ist", () => {
    // Der aktuelle Zustand dieses Systems.
    const fleet = summarizeFleet([
      report("jupiter", "BLOCKED", ["ROUTE_QUOTE"]),
      report("dexscreener", "BLOCKED"),
      report("birdeye", "NOT_CONFIGURED"),
    ]);

    expect(fleet.anyMarketDataConnected).toBe(false);
    expect(fleet.anyMarketDataUsable).toBe(false);
    expect(fleet.blockedCount).toBe(2);
    expect(fleet.summary).toMatch(/vom Netz gesperrt/);
  });

  it("erkennt eine verbundene Marktdatenquelle", () => {
    const fleet = summarizeFleet([
      report("dexscreener", "CONNECTED"),
      report("birdeye", "NOT_CONFIGURED"),
    ]);
    expect(fleet.anyMarketDataConnected).toBe(true);
    expect(fleet.summary).toMatch(/1 von 2 Marktdatenquellen verbunden/);
  });

  it("zaehlt eine eingeschraenkte Quelle als nutzbar, aber nicht als verbunden", () => {
    const fleet = summarizeFleet([report("dexscreener", "DEGRADED")]);
    expect(fleet.anyMarketDataConnected).toBe(false);
    expect(fleet.anyMarketDataUsable).toBe(true);
  });
});
