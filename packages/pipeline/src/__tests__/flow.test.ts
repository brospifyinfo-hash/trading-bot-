import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_STATE, providerId, type SystemState } from "@sae/core";
import { summarizeFleet, type ProviderStatusReport } from "@sae/providers";

import { evaluateReadiness, planBranches, signalValidity } from "../flow";
import type { SnapshotProvenance } from "../ingestion";
import { marketDataFieldsFrom, type MarketDataFields } from "../market-data-quality";

function report(status: ProviderStatusReport["status"]): ProviderStatusReport {
  return {
    providerId: providerId("dexscreener"),
    kind: "market",
    status,
    capabilities: ["TOKEN_MARKET"],
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

const blockedFleet = summarizeFleet([report("BLOCKED")]);
const connectedFleet = summarizeFleet([report("CONNECTED")]);

const primary: SnapshotProvenance = {
  providerId: providerId("dexscreener"),
  tier: "PRIMARY",
  freshnessSeconds: 8,
  contributors: [],
};
const fallback: SnapshotProvenance = { ...primary, tier: "FALLBACK" };
const stale: SnapshotProvenance = { ...primary, freshnessSeconds: 900 };

/** Eine Datenlage, die die Qualitaetspruefung besteht. */
const vollstaendig: MarketDataFields = marketDataFieldsFrom({
  priceUsd: 0.00042,
  liquidityUsd: 180_000,
  marketCapUsd: 2_400_000,
  volume24hUsd: 95_000,
});
const geprueft = { kind: "CHECK", market: vollstaendig } as const;

function readiness(overrides: Partial<Parameters<typeof evaluateReadiness>[0]> = {}) {
  return evaluateReadiness({
    fleet: connectedFleet,
    systemState: DEFAULT_SYSTEM_STATE,
    snapshotCount: 500,
    minSnapshotsForAnalysis: 100,
    ...overrides,
  });
}

describe("Startbedingung", () => {
  it("wartet ohne Quelle und nennt den Grund", () => {
    const r = readiness({ fleet: blockedFleet });
    expect(r.phase).toBe("WAITING_FOR_MARKET_DATA");
    expect(r.canDiscover).toBe(false);
    expect(r.canPaperTrade).toBe(false);
    expect(r.blockedBy.join(" ")).toMatch(/Keine erreichbare Marktdatenquelle/);
  });

  it("baut zunaechst Historie auf, bevor bewertet wird", () => {
    const r = readiness({ snapshotCount: 10 });
    expect(r.phase).toBe("BUILDING_HISTORY");
    expect(r.canIngest).toBe(true);
    expect(r.canAnalyze).toBe(false);
    expect(r.blockedBy.join(" ")).toMatch(/Historie zu duenn/);
  });

  it("laeuft an, sobald Daten und Historie da sind", () => {
    const r = readiness();
    expect(r.phase).toBe("RUNNING");
    expect(r.canDiscover).toBe(true);
    expect(r.canAnalyze).toBe(true);
    expect(r.canCreateOpportunities).toBe(true);
    expect(r.canPaperTrade).toBe(true);
  });
});

describe("Paper haengt nicht am Live-Handel", () => {
  it("laeuft bei ausgeschaltetem Live-Handel", () => {
    const r = readiness({
      systemState: { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: false },
    });
    expect(r.canPaperTrade).toBe(true);
    expect(r.canLiveTrade).toBe(false);
  });

  it("laeuft auch beim Notstopp", () => {
    // Ein Notstopp schuetzt Kapital, nicht die Datenerhebung.
    const stopped: SystemState = {
      liveTradingEnabled: true,
      manualAlertsEnabled: true,
      emergencyStop: true,
    };
    const r = readiness({ systemState: stopped });
    expect(r.canPaperTrade).toBe(true);
    expect(r.canLiveTrade).toBe(false);
  });
});

describe("Verzweigung in die Stroeme", () => {
  it("oeffnet Auto und Manual gemeinsam", () => {
    // Getrennt erzeugt waere die Frage „haette der Mensch besser entschieden"
    // nicht mehr beantwortbar.
    const plan = planBranches({
      readiness: readiness(),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: primary,
      dataQuality: geprueft,
    });

    expect(plan.openStreams).toContain("AUTO_PAPER");
    expect(plan.openStreams).toContain("MANUAL_PAPER");
    expect(plan.producesAnything).toBe(true);
  });

  it("laesst Live zu, wenn alles stimmt", () => {
    const plan = planBranches({
      readiness: readiness({
        systemState: { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true },
      }),
      systemState: { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true },
      provenance: primary,
      dataQuality: geprueft,
    });
    expect(plan.openStreams).toContain("LIVE");
  });

  it("schliesst bei Fallback-Daten JEDEN Strom, auch Paper", () => {
    // Geaendertes Verhalten, und der Grund gehoert hierher: frueher blieb Paper
    // auf Fallback-Daten offen. Paper ist aber die Grundlage der spaeteren
    // Statistik — laeuft es auf Daten, die fuer eine Einstiegsentscheidung
    // ausdruecklich nicht gut genug sind, misst diese Statistik die
    // Datenqualitaet und nicht die Strategie. Beobachten und speichern darf man
    // Fallback-Daten weiterhin; eine Gelegenheit entsteht daraus nicht.
    const state: SystemState = { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true };
    const plan = planBranches({
      readiness: readiness({ systemState: state }),
      systemState: state,
      provenance: fallback,
      dataQuality: geprueft,
    });

    expect(plan.openStreams).toEqual([]);
    expect(plan.branches.every((b) => b.reason === "DATA_QUALITY_TOO_LOW")).toBe(true);
  });

  it("schliesst Paper, wenn ein Pflichtfeld fehlt", () => {
    // Der Fall, den es vorher nicht gab: Herkunft und Alter in Ordnung, aber
    // die Liquiditaet hat der Anbieter nicht geliefert.
    const plan = planBranches({
      readiness: readiness(),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: primary,
      dataQuality: {
        kind: "CHECK",
        market: marketDataFieldsFrom({ ...vollstaendig, liquidityUsd: null }),
      },
    });

    expect(plan.openStreams).toEqual([]);
    const auto = plan.branches.find((b) => b.stream === "AUTO_PAPER")!;
    expect(auto.reason).toBe("DATA_QUALITY_TOO_LOW");
    expect(auto.detail).toContain("liquidityUsd");
  });

  it("schliesst Paper, wenn zum Snapshot gar keine Marktdaten vorliegen", () => {
    const plan = planBranches({
      readiness: readiness(),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: primary,
      dataQuality: { kind: "CHECK", market: null },
    });
    expect(plan.openStreams).toEqual([]);
  });

  it("laesst einen gekennzeichneten Test-Fixture durch und sagt es", () => {
    // Ein Fixture behauptet keine Marktlage. Ihn durch die Feldpruefung zu
    // schicken hiesse, ihn abzulehnen; ihm Felder zu erfinden waere schlimmer.
    const plan = planBranches({
      readiness: readiness(),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: null,
      dataQuality: { kind: "WAIVED_TEST_FIXTURE", label: "pipeline-nachweis" },
    });

    expect(plan.openStreams).toContain("AUTO_PAPER");
    // Und der Verzicht steht in der Begruendung. Ein ausgesetzter Gate, der in
    // der Aufzeichnung wie ein bestandener aussieht, waere die schlechtere
    // Variante von gar keiner Aufzeichnung.
    const auto = plan.branches.find((b) => b.stream === "AUTO_PAPER")!;
    expect(auto.detail).toContain("Test-Fixture");
    expect(auto.detail).toContain("pipeline-nachweis");
  });

  it("erzeugt ohne Marktdaten gar nichts", () => {
    const plan = planBranches({
      readiness: readiness({ fleet: blockedFleet }),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: null,
      dataQuality: { kind: "CHECK", market: null },
    });
    expect(plan.openStreams).toEqual([]);
    expect(plan.producesAnything).toBe(false);
    expect(plan.branches.every((b) => b.reason === "NO_MARKET_DATA")).toBe(true);
  });
});

describe("Ein Datenausfall erzeugt kein Signal", () => {
  it("weist ein Signal ohne Marktdaten ab", () => {
    const v = signalValidity({ fleet: blockedFleet, provenance: primary, market: vollstaendig });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("NO_MARKET_DATA");
  });

  it("weist ein Signal ohne Snapshot ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: null, market: vollstaendig });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("NO_SNAPSHOT");
  });

  it("weist ein Signal auf Fallback-Daten ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: fallback, market: vollstaendig });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("FALLBACK_DATA");
  });

  it("weist ein Signal auf veralteten Daten ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: stale, market: vollstaendig });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("STALE_DATA");
  });

  it("weist ein Signal ab, dem ein Pflichtfeld fehlt", () => {
    // Eine Quelle, die antwortet und dabei die Haelfte weglaesst, ist derselbe
    // Fall wie eine, die schweigt: die Zahlen sind nicht da.
    const v = signalValidity({
      fleet: connectedFleet,
      provenance: primary,
      market: marketDataFieldsFrom({ ...vollstaendig, volume24hUsd: null }),
    });
    expect(v.valid).toBe(false);
    if (!v.valid) {
      expect(v.rejection).toBe("INCOMPLETE_MARKET_DATA");
      expect(v.detail).toContain("volume24hUsd");
    }
  });

  it("weist ein Signal ohne jede Marktdaten ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: primary, market: null });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("INCOMPLETE_MARKET_DATA");
  });

  it("laesst ein Signal auf frischen, vollstaendigen Primaerdaten zu", () => {
    expect(
      signalValidity({ fleet: connectedFleet, provenance: primary, market: vollstaendig }).valid,
    ).toBe(true);
  });
});
