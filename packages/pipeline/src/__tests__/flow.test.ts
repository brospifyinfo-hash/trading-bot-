import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_STATE, providerId, type SystemState } from "@sae/core";
import { summarizeFleet, type ProviderStatusReport } from "@sae/providers";

import { evaluateReadiness, planBranches, signalValidity } from "../flow";
import type { SnapshotProvenance } from "../ingestion";

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
    });
    expect(plan.openStreams).toContain("LIVE");
  });

  it("schliesst Live bei Fallback-Daten, laesst Paper offen", () => {
    const state: SystemState = { ...DEFAULT_SYSTEM_STATE, liveTradingEnabled: true };
    const plan = planBranches({
      readiness: readiness({ systemState: state }),
      systemState: state,
      provenance: fallback,
    });

    expect(plan.openStreams).toEqual(["AUTO_PAPER", "MANUAL_PAPER"]);
    const live = plan.branches.find((b) => b.stream === "LIVE")!;
    expect(live.reason).toBe("DATA_QUALITY_TOO_LOW");
  });

  it("erzeugt ohne Marktdaten gar nichts", () => {
    const plan = planBranches({
      readiness: readiness({ fleet: blockedFleet }),
      systemState: DEFAULT_SYSTEM_STATE,
      provenance: null,
    });
    expect(plan.openStreams).toEqual([]);
    expect(plan.producesAnything).toBe(false);
    expect(plan.branches.every((b) => b.reason === "NO_MARKET_DATA")).toBe(true);
  });
});

describe("Ein Datenausfall erzeugt kein Signal", () => {
  it("weist ein Signal ohne Marktdaten ab", () => {
    const v = signalValidity({ fleet: blockedFleet, provenance: primary });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("NO_MARKET_DATA");
  });

  it("weist ein Signal ohne Snapshot ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: null });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("NO_SNAPSHOT");
  });

  it("weist ein Signal auf Fallback-Daten ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: fallback });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("FALLBACK_DATA");
  });

  it("weist ein Signal auf veralteten Daten ab", () => {
    const v = signalValidity({ fleet: connectedFleet, provenance: stale });
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.rejection).toBe("STALE_DATA");
  });

  it("laesst ein Signal auf frischen Primaerdaten zu", () => {
    expect(signalValidity({ fleet: connectedFleet, provenance: primary }).valid).toBe(true);
  });
});
