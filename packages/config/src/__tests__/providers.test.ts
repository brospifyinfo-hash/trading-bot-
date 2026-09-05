import { describe, expect, it } from "vitest";

import { marketDataPriority, readProviderConfig, type ProviderEnv } from "../providers";

const empty: ProviderEnv = {};

describe("Provider-Konfiguration", () => {
  it("meldet ohne Eintraege alles als nicht konfiguriert", () => {
    // Der aktuelle Zustand — eine Feststellung, kein Fehler.
    const entries = readProviderConfig(empty);
    expect(entries.every((e) => !e.configured)).toBe(true);
  });

  it("verlangt bei Anbietern mit Schluessel beides", () => {
    const withUrlOnly = readProviderConfig({ BIRDEYE_BASE_URL: "https://example.invalid" });
    const birdeye = withUrlOnly.find((e) => e.id === "birdeye")!;
    expect(birdeye.apiKeyPresent).toBe(false);
    expect(birdeye.configured).toBe(false);

    const complete = readProviderConfig({
      BIRDEYE_BASE_URL: "https://example.invalid",
      BIRDEYE_API_KEY: "k",
    });
    expect(complete.find((e) => e.id === "birdeye")!.configured).toBe(true);
  });

  it("trennt Konfiguration von vorhandenem Adapter", () => {
    // Ein konfigurierter Anbieter ohne Adapter ist nicht ansprechbar — und der
    // Unterschied gehoert sichtbar, sonst sucht jemand den Fehler bei den
    // Zugangsdaten. Helius steht hier fuer diesen Fall: konfiguriert, aber
    // ohne geprueftes Response-Schema.
    const entries = readProviderConfig({
      HELIUS_BASE_URL: "https://example.invalid",
      HELIUS_API_KEY: "irrelevant",
    });
    const helius = entries.find((e) => e.id === "helius")!;
    expect(helius.configured).toBe(true);
    expect(helius.adapterImplemented).toBe(false);
  });

  it("fuehrt genau die Anbieter mit gepruefter Antwortform", () => {
    // Diese Liste ist absichtlich hart: sie waechst nur, wenn ein
    // Response-Vertrag tatsaechlich gegen eine Primaerquelle geprueft wurde.
    //
    // - jupiter: gegen die herstellereigene OpenAPI-Spezifikation, 2026-08-30
    // - dexscreener: gegen eine echte API-Antwort, 2026-09-03 (siehe
    //   packages/providers/src/dexscreener/__tests__/real-response.ts)
    //
    // Wer hier einen Anbieter ergaenzt, ohne dass sein Schema aus einer
    // Primaerquelle stammt, hebelt die wichtigste Regel des Provider-Layers
    // aus — und dieser Test ist die Stelle, an der das auffaellt.
    const entries = readProviderConfig(empty);
    const implemented = entries.filter((e) => e.adapterImplemented).map((e) => e.id);
    expect(implemented.sort()).toEqual(["dexscreener", "jupiter"]);
  });

  it("enthaelt keine Endpunktpfade", () => {
    // Basis-URLs und Schluessel — mehr nicht. Ein konfigurierbarer Pfad waere
    // fuer jeden Anbieter ausser Jupiter eine Erfindung.
    const entries = readProviderConfig({ DEXSCREENER_BASE_URL: "https://example.invalid/v1" });
    for (const entry of entries) {
      expect(Object.keys(entry)).not.toContain("path");
      expect(Object.keys(entry)).not.toContain("endpoints");
    }
  });
});

describe("Prioritaetskette", () => {
  it("bildet die Reihenfolge aus der Konfiguration ab", () => {
    const tiers = marketDataPriority(
      { MARKET_DATA_PRIORITY: "birdeye,dexscreener" },
      ["dexscreener", "birdeye"],
    );
    expect(tiers.get("birdeye")).toBe("PRIMARY");
    expect(tiers.get("dexscreener")).toBe("SECONDARY");
  });

  it("stellt nicht genannte Anbieter auf FALLBACK", () => {
    const tiers = marketDataPriority({ MARKET_DATA_PRIORITY: "birdeye" }, ["dexscreener", "birdeye"]);
    // Nicht ausgeschlossen, aber auch nicht entscheidungstragend.
    expect(tiers.get("dexscreener")).toBe("FALLBACK");
  });

  it("ignoriert genannte Anbieter, die es nicht gibt", () => {
    const tiers = marketDataPriority({ MARKET_DATA_PRIORITY: "erfunden,dexscreener" }, ["dexscreener"]);
    expect(tiers.get("dexscreener")).toBe("SECONDARY");
    expect(tiers.size).toBe(1);
  });

  it("kommt ohne Konfiguration aus", () => {
    const tiers = marketDataPriority({}, ["dexscreener", "birdeye"]);
    expect([...tiers.values()]).toEqual(["FALLBACK", "FALLBACK"]);
  });
});
