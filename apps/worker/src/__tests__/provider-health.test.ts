import { describe, expect, it } from "vitest";
import { summarizeFleet } from "@sae/providers";

import { buildStatusReports } from "../roles/provider-health";

/**
 * Was der Worker meldet, wenn nichts konfiguriert ist.
 *
 * Das ist kein Randfall, sondern der Auslieferungszustand — und die Meldung
 * muss den Unterschied zwischen „nichts hinterlegt" und „ausgefallen" treffen.
 */

const BASE = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
} satisfies NodeJS.ProcessEnv;

describe("Provider-Statusbericht", () => {
  it("meldet ohne Konfiguration alles als NOT_CONFIGURED", () => {
    const reports = buildStatusReports(BASE);
    expect(reports.every((r) => r.status === "NOT_CONFIGURED")).toBe(true);
    expect(summarizeFleet(reports).anyMarketDataConnected).toBe(false);
  });

  it("nennt fehlende Zugangsdaten getrennt von fehlender URL", () => {
    const reports = buildStatusReports({
      ...BASE,
      BIRDEYE_BASE_URL: "https://example.invalid",
    });
    const birdeye = reports.find((r) => r.providerId === "birdeye")!;
    expect(birdeye.detail).toMatch(/Zugangsschluessel fehlt/);
  });

  it("unterscheidet konfiguriert-ohne-Adapter von nicht konfiguriert", () => {
    // Sonst sucht jemand den Fehler bei den Zugangsdaten, obwohl das
    // Adapter-Modul fehlt.
    // Helius steht fuer diesen Fall: konfiguriert, aber ohne geprueftes
    // Response-Schema. DexScreener taugt seit dem 2026-09-03 nicht mehr als
    // Beispiel — sein Vertrag ist gegen eine echte Antwort geprueft.
    const reports = buildStatusReports({
      ...BASE,
      HELIUS_BASE_URL: "https://example.invalid",
      HELIUS_API_KEY: "irrelevant",
    });
    const helius = reports.find((r) => r.providerId === "helius")!;
    expect(helius.detail).toMatch(/kein geprueftes Adapter-Modul/);
  });

  it("behauptet fuer keinen Anbieter einen Erfolg", () => {
    // Es wurde nichts abgefragt, also gibt es nichts zu melden — und
    // insbesondere keine Frische.
    for (const report of buildStatusReports(BASE)) {
      expect(report.lastSuccessAt).toBeNull();
      expect(report.dataFreshnessSeconds).toBeNull();
      expect(report.latencyMsP95).toBeNull();
    }
  });

  it("fuehrt die Faehigkeiten je Anbieter mit", () => {
    const reports = buildStatusReports(BASE);
    const jupiter = reports.find((r) => r.providerId === "jupiter")!;
    expect(jupiter.capabilities).toContain("ROUTE_QUOTE");
    expect(jupiter.kind).toBe("router");
  });
});
