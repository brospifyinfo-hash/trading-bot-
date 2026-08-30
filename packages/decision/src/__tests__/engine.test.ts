import { describe, expect, it } from "vitest";
import { computeScores } from "@sae/scoring";
import { decide } from "../engine";
import { emptyEv, goodFeatures, makeContext, solidButNotEnoughFeatures, val } from "./fixtures";

describe("Entscheidung: ENTER", () => {
  it("laesst einen Token durch, der alle Bedingungen erfuellt", () => {
    const decision = decide(makeContext());
    expect(decision.kind).toBe("ENTER");
    expect(decision.rejectionReasons).toEqual([]);
    expect(decision.reasons.map((r) => r.code)).toContain("SCORE_ABOVE_THRESHOLD");
  });

  it("begruendet die Entscheidung nachvollziehbar", () => {
    // "Warum hat das System hier gekauft?" muss beantwortbar sein.
    const decision = decide(makeContext());
    expect(decision.reasons.length).toBeGreaterThan(0);
    expect(decision.reasons.map((r) => r.code)).toContain("POSITIVE_EV");
    expect(decision.scoreEngineVersion).toBe("1.0.0");
  });
});

describe("Hard Gates schlagen jeden Score", () => {
  it("lehnt bei aktiver Mint-Authority ab, egal wie gut der Score ist", () => {
    const features = goodFeatures();
    const decision = decide(
      makeContext({
        features: {
          ...features,
          security: { ...features.security, mintAuthorityActive: val(true) },
        },
      }),
    );
    expect(decision.kind).toBe("REJECT");
    expect(decision.rejectionReasons).toContain("MINT_AUTHORITY_ACTIVE");
  });

  it("lehnt bei CRITICAL ab", () => {
    const features = goodFeatures();
    const decision = decide(
      makeContext({
        features: { ...features, security: { ...features.security, riskLevel: val("CRITICAL" as const) } },
      }),
    );
    expect(decision.rejectionReasons).toContain("SECURITY_CRITICAL");
  });

  it("lehnt bei ungesperrter Liquiditaet ab", () => {
    const features = goodFeatures();
    const decision = decide(
      makeContext({
        features: { ...features, security: { ...features.security, lpBurnedOrLocked: val(false) } },
      }),
    );
    expect(decision.rejectionReasons).toContain("LIQUIDITY_NOT_LOCKED");
  });

  it("lehnt ab, wenn die Position nicht wieder herausgeht", () => {
    const features = goodFeatures();
    const decision = decide(
      makeContext({
        features: { ...features, execution: { ...features.execution, exitCapacityRatio: val(1.1) } },
      }),
    );
    expect(decision.rejectionReasons).toContain("EXIT_CAPACITY_INSUFFICIENT");
  });

  it("lehnt bei zu geringer Liquiditaet ab", () => {
    const features = goodFeatures();
    const decision = decide(
      makeContext({
        features: { ...features, market: { ...features.market, liquidityUsd: val(5_000) } },
      }),
    );
    expect(decision.rejectionReasons).toContain("LIQUIDITY_TOO_LOW");
  });

  it("lehnt einen bereits offenen Intent ab", () => {
    expect(decide(makeContext({ hasOpenIntentOnMint: true })).rejectionReasons).toContain(
      "DUPLICATE_OPEN_INTENT",
    );
  });

  it("lehnt ab, wenn eine kritische Datenquelle fehlt", () => {
    expect(
      decide(makeContext({ criticalProvidersUnavailable: ["router"] })).rejectionReasons,
    ).toContain("PROVIDER_UNHEALTHY");
  });

  it("kennt keinen Ausnahmepfad fuer hohe Scores", () => {
    // Es gibt bewusst keine Moeglichkeit, ein Hard Gate zu ueberstimmen.
    const features = goodFeatures();
    const perfect = computeScores(features);
    expect(perfect.finalScore).toBeGreaterThan(70);
    const decision = decide(
      makeContext({
        features: {
          ...features,
          security: { ...features.security, freezeAuthorityActive: val(true) },
        },
      }),
    );
    expect(decision.kind).toBe("REJECT");
  });
});

describe("Entscheidung: WATCH", () => {
  it("beobachtet weiter, statt abzulehnen, wenn nur der Score fehlt", () => {
    const ctx = makeContext();
    const decision = decide({
      ...ctx,
      scoring: { ...ctx.scoring, finalScore: 60 as never },
    });
    expect(decision.kind).toBe("WATCH");
    expect(decision.rejectionReasons).toEqual([]);
  });

  it("beobachtet einen soliden, aber nicht ueberzeugenden Token", () => {
    // Kalibrierungsbefund, kein Zufall: mit den Standardgewichten reicht ein
    // Token, der ueberall solide ist (Score 73), nicht fuer einen Einstieg —
    // drei qualifizierte Kaeufer und moderates Holder-Wachstum ziehen ihn unter
    // die Schwelle von 75. Das ist die beabsichtigte Konservativitaet und muss
    // sichtbar bleiben, falls jemand spaeter an den Gewichten dreht.
    const decision = decide(makeContext({ features: solidButNotEnoughFeatures() }));
    expect(decision.kind).toBe("WATCH");
    expect(decision.finalScore).toBeLessThan(75);
    expect(decision.finalScore).toBeGreaterThan(65);
  });

  it("nennt die verfehlte Schwelle", () => {
    const ctx = makeContext();
    const decision = decide({ ...ctx, scoring: { ...ctx.scoring, finalScore: 60 as never } });
    expect(decision.reasons.map((r) => r.code)).toContain("BELOW_ENTRY_SCORE");
  });
});

describe("Circuit Breaker und Portfolio", () => {
  it("lehnt bei ausgeloestem Breaker ab", () => {
    const decision = decide(
      makeContext({
        breakers: {
          open: [],
          entriesBlocked: true,
          allTradingBlocked: false,
          reasons: ["Tagesverlust erreicht"],
        },
      }),
    );
    expect(decision.rejectionReasons).toContain("CIRCUIT_BREAKER_OPEN");
    expect(decision.risks.map((r) => r.detail)).toContain("Tagesverlust erreicht");
  });

  it("lehnt bei verletzter Portfolio-Grenze ab", () => {
    const decision = decide(
      makeContext({ exposureViolations: ["MAX_OPEN_POSITIONS_REACHED"] }),
    );
    expect(decision.rejectionReasons).toContain("MAX_OPEN_POSITIONS_REACHED");
  });
});

describe("Erwartungswert und der Bootstrap-Fall", () => {
  it("laesst UNKNOWN im Paper-Betrieb zu", () => {
    // Ohne Trades entsteht keine Historie, ohne Historie keine Schaetzung.
    // Genau dafuer ist der Paper-Betrieb da.
    const decision = decide(makeContext({ ev: emptyEv, executionMode: "paper" }));
    expect(decision.kind).toBe("ENTER");
    expect(decision.reasons.map((r) => r.code)).toContain("EV_UNKNOWN_PAPER");
  });

  it("lehnt UNKNOWN im Live-Betrieb ab", () => {
    // Echtes Geld wird nicht auf eine Groesse gesetzt, die niemand kennt.
    const decision = decide(
      makeContext({ ev: emptyEv, executionMode: "live", liveTradingEnabled: true }),
    );
    expect(decision.kind).toBe("REJECT");
    expect(decision.rejectionReasons).toContain("EV_UNKNOWN_INSUFFICIENT_HISTORY");
  });

  it("lehnt einen negativen Erwartungswert ab", () => {
    const negative = {
      estimate: { kind: "ESTIMATED" as const, evPerUnit: -0.03, confidence: 0.9, sampleSize: 200 },
      pointEv: -0.03,
      conservativeEv: -0.03,
      winRate: 0.4,
      winRateLowerBound: 0.35,
      avgWin: 0.2,
      avgLoss: 0.2,
    };
    expect(decide(makeContext({ ev: negative })).rejectionReasons).toContain("EV_NEGATIVE");
  });

  it("verlangt im Live-Betrieb ausreichende Konfidenz", () => {
    const shaky = {
      estimate: { kind: "ESTIMATED" as const, evPerUnit: 0.05, confidence: 0.2, sampleSize: 110 },
      pointEv: 0.09,
      conservativeEv: 0.05,
      winRate: 0.6,
      winRateLowerBound: 0.45,
      avgWin: 0.3,
      avgLoss: 0.2,
    };
    const live = decide(
      makeContext({ ev: shaky, executionMode: "live", liveTradingEnabled: true }),
    );
    expect(live.kind).toBe("REJECT");
    // Im Paper-Betrieb ist dieselbe Schaetzung in Ordnung.
    expect(decide(makeContext({ ev: shaky, executionMode: "paper" })).kind).toBe("ENTER");
  });
});

describe("Live-Freischaltung", () => {
  it("lehnt Live ohne bewusste Aktivierung ab", () => {
    const decision = decide(makeContext({ executionMode: "live", liveTradingEnabled: false }));
    expect(decision.kind).toBe("REJECT");
    expect(decision.rejectionReasons).toContain("LIVE_TRADING_DISABLED");
  });
});

describe("Determinismus", () => {
  it("liefert bei gleichen Eingaben dieselbe Entscheidung", () => {
    const a = decide(makeContext());
    const b = decide(makeContext());
    expect(a.kind).toBe(b.kind);
    expect(a.reasons).toEqual(b.reasons);
  });
});
