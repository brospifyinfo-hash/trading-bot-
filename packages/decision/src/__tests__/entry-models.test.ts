import { describe, expect, it } from "vitest";
import { missing, observed, providerId, tokenId, type Maybe } from "@sae/core";
import type { FeatureVector } from "@sae/scoring";

import {
  ALL_ENTRY_MODEL_IDS,
  buildEntryModels,
  evaluateEntryModels,
  type EntryModelContext,
  type EntryModelId,
} from "../entry-models";

const SRC = providerId("fixture");
const T0 = new Date("2026-08-30T12:00:00Z");
const val = <T>(v: T): Maybe<T> => observed(v, SRC, T0);
const gone = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", T0, SRC);

function features(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    tokenId: tokenId("token-1"),
    asOf: T0,
    security: {
      mintAuthorityActive: val(false),
      freezeAuthorityActive: val(false),
      lpBurnedOrLocked: val(true),
      top10HolderSharePct: val(18),
      topHolderSharePct: val(5),
      riskLevel: val("LOW" as const),
    },
    market: {
      priceUsd: val(0.00042),
      liquidityUsd: val(120_000),
      marketCapUsd: val(1_800_000),
      volume24hUsd: val(450_000),
      tokenAgeSeconds: val(3_600),
    },
    momentum: {
      priceChange5m: val(0.18),
      priceChange1h: val(0.42),
      volumeAcceleration: val(2.4),
      buys5m: val(180),
      sells5m: val(70),
    },
    holder: {
      holders: val(900),
      holderGrowth: val(70),
      distinctActors: val(820),
      largestClusterSharePct: val(8),
    },
    execution: {
      expectedCostBps: val(180),
      exitCapacityRatio: val(6),
      priceImpactBps: val(90),
    },
    pending: {
      smartMoneyBuyers: gone(),
      smartMoneySellers: gone(),
      socialAuthenticity: gone(),
      socialMomentum: gone(),
      devScore: gone(),
      narrativeScore: gone(),
    },
    ...overrides,
  };
}

const ALL = new Set<EntryModelId>(ALL_ENTRY_MODEL_IDS);

function ctx(overrides: Partial<EntryModelContext> = {}): EntryModelContext {
  return { features: features(), pullbackFromHigh: gone<number>(), ...overrides };
}

describe("Einstiegsmodelle", () => {
  it("laesst mehrere Modelle gleichzeitig ausloesen", () => {
    // Ein Token kann zugleich bestaetigt UND beschleunigend sein. Auf das
    // erste Treffer-Modell reduziert haenge die Zuordnung an der Reihenfolge
    // im Array — und die Statistik misst am Ende die Sortierung.
    const result = evaluateEntryModels(ctx(), ALL);
    expect(result.matched).toEqual(["CONFIRMATION", "MOMENTUM"]);
  });

  it("trennt fehlende Daten von nicht ausgeloest", () => {
    const result = evaluateEntryModels(ctx(), ALL);

    // RETEST braucht den Rueckgang vom Hoch; der fehlt hier.
    expect(result.notComputable).toEqual(["RETEST"]);
    expect(result.noMatch).not.toContain("RETEST");
    const detail = result.details.RETEST;
    expect(detail?.kind).toBe("NOT_COMPUTABLE");
    if (detail?.kind === "NOT_COMPUTABLE") {
      expect(detail.missing).toEqual(["pullbackFromHigh"]);
    }
  });

  it("benennt jedes fehlende Feld einzeln", () => {
    const blind = evaluateEntryModels(
      ctx({
        features: features({
          market: { ...features().market, tokenAgeSeconds: gone() },
          holder: { ...features().holder, distinctActors: gone() },
        }),
      }),
      ALL,
    );
    const early = blind.details.EARLY;
    expect(early?.kind).toBe("NOT_COMPUTABLE");
    if (early?.kind === "NOT_COMPUTABLE") {
      expect(early.missing).toEqual(["market.tokenAgeSeconds", "holder.distinctActors"]);
    }
  });

  it("laesst sich einzeln abschalten", () => {
    const only = evaluateEntryModels(ctx(), new Set<EntryModelId>(["MOMENTUM"]));
    expect(only.matched).toEqual(["MOMENTUM"]);
    expect(only.disabled).toEqual(["EARLY", "CONFIRMATION", "RETEST"]);
    // Abgeschaltete Modelle stehen nicht in `noMatch` — sie wurden nicht
    // gefragt, sie haben nicht abgelehnt.
    expect(only.noMatch).toEqual([]);
  });
});

describe("EARLY", () => {
  const early = buildEntryModels().find((m) => m.id === "EARLY")!;

  it("greift bei einem jungen Token mit verteilter Kaeuferbasis", () => {
    const result = early.evaluate(
      ctx({
        features: features({
          market: { ...features().market, tokenAgeSeconds: val(300) },
          holder: { ...features().holder, distinctActors: val(60) },
        }),
      }),
    );
    expect(result.kind).toBe("MATCH");
  });

  it("greift nicht, wenn hinter dem Kurs ein einzelner Akteur steht", () => {
    // „Frueh" ohne verteilte Kaeuferbasis ist nur ein anderes Wort fuer „vor
    // allen anderen im Ausstieg eines Einzelnen".
    const result = early.evaluate(
      ctx({
        features: features({
          market: { ...features().market, tokenAgeSeconds: val(300) },
          holder: { ...features().holder, distinctActors: val(4) },
        }),
      }),
    );
    expect(result.kind).toBe("NO_MATCH");
  });
});

describe("RETEST", () => {
  const retest = buildEntryModels().find((m) => m.id === "RETEST")!;

  it("greift in der Korrekturspanne", () => {
    expect(retest.evaluate(ctx({ pullbackFromHigh: val(0.3) })).kind).toBe("MATCH");
  });

  it("greift nicht bei einem Rueckgang, der keine Korrektur mehr ist", () => {
    // Ohne obere Grenze waere „Retest" nur ein Name fuer fallendes Messer fangen.
    expect(retest.evaluate(ctx({ pullbackFromHigh: val(0.8) })).kind).toBe("NO_MATCH");
  });

  it("greift nicht ohne Rueckgang", () => {
    expect(retest.evaluate(ctx({ pullbackFromHigh: val(0.05) })).kind).toBe("NO_MATCH");
  });
});
