import { describe, expect, it } from "vitest";

import {
  assessMarketData,
  explainVerdict,
  marketDataSupportsEntry,
  DEFAULT_QUALITY_THRESHOLDS,
  REQUIRED_FOR_ENTRY,
  type MarketDataFields,
  type QualityInput,
} from "../market-data-quality";

/**
 * Der Gate vor jeder Gelegenheit.
 *
 * Die wichtigste Zusicherung dieser Datei steht im ersten Block: ein fehlendes
 * Feld fuehrt NIE zu einer Gelegenheit, und es wird nie wie eine Null
 * behandelt. Ein Token ohne gemeldete Liquiditaet ist nicht ein Token mit
 * Liquiditaet 0.
 */

const VOLLSTAENDIG: MarketDataFields = {
  priceUsd: 0.00042,
  liquidityUsd: 180_000,
  marketCapUsd: 2_400_000,
  fdvUsd: 4_100_000,
  volume24hUsd: 95_000,
  buyCount24h: 812,
  sellCount24h: 640,
  buyVolume24hUsd: 51_000,
  sellVolume24hUsd: 44_000,
  tradeCount24h: 1_452,
  uniqueWallets24h: 389,
  holders: 2_140,
};

const gut = (over: Partial<QualityInput> = {}): QualityInput => ({
  fields: VOLLSTAENDIG,
  tier: "PRIMARY",
  freshnessSeconds: 8,
  ...over,
});

describe("Fehlend ist nicht null", () => {
  for (const feld of REQUIRED_FOR_ENTRY) {
    it(`lehnt ab, wenn ${feld} fehlt`, () => {
      const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, [feld]: null } }));
      expect(v.kind).toBe("INCOMPLETE");
      if (v.kind === "INCOMPLETE") expect(v.missing).toContain(feld);
    });

    it(`unterscheidet fehlendes ${feld} von einem Wert 0`, () => {
      const fehlt = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, [feld]: null } }));
      const null_ = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, [feld]: 0 } }));
      // Beide erzeugen keine Gelegenheit — aber aus verschiedenen Gruenden,
      // und genau diese Unterscheidung ist der Zweck.
      expect(fehlt.kind).toBe("INCOMPLETE");
      expect(null_.kind).not.toBe("INCOMPLETE");
    });
  }

  it("nennt alle fehlenden Felder auf einmal", () => {
    const v = assessMarketData(
      gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: null, volume24hUsd: null } }),
    );
    expect(v.kind).toBe("INCOMPLETE");
    if (v.kind === "INCOMPLETE") {
      expect(v.missing).toEqual(expect.arrayContaining(["liquidityUsd", "volume24hUsd"]));
    }
  });

  it("laesst optionale Felder fehlen, ohne abzulehnen", () => {
    // Buy/Sell-Zaehler und Unique Wallets verbessern eine Entscheidung, tragen
    // sie aber nicht allein. Sie zur Pflicht zu machen hiesse, die
    // Anbieterwahl zur Strategieentscheidung zu machen.
    const v = assessMarketData(
      gut({
        fields: {
          ...VOLLSTAENDIG,
          buyCount24h: null,
          sellCount24h: null,
          uniqueWallets24h: null,
          holders: null,
          fdvUsd: null,
        },
      }),
    );
    expect(v.kind).toBe("PASS");
  });
});

describe("Herkunft und Alter zuerst", () => {
  it("lehnt FALLBACK-Daten ab, auch wenn alles vollstaendig ist", () => {
    expect(assessMarketData(gut({ tier: "FALLBACK" })).kind).toBe("UNTRUSTED_SOURCE");
  });

  it("lehnt veraltete Daten ab", () => {
    const v = assessMarketData(gut({ freshnessSeconds: 900 }));
    expect(v.kind).toBe("STALE");
    if (v.kind === "STALE") expect(v.ageSeconds).toBe(900);
  });

  it("nennt das Alter als Grund, wenn Alter UND Schwelle verletzt sind", () => {
    // Die Reihenfolge entscheidet, welche Auskunft der Betreiber bekommt.
    // „900 s alt" fuehrt zur Ursache, „Liquiditaet zu niedrig" in die Irre.
    const v = assessMarketData(
      gut({ freshnessSeconds: 900, fields: { ...VOLLSTAENDIG, liquidityUsd: 1 } }),
    );
    expect(v.kind).toBe("STALE");
  });

  it("akzeptiert SECONDARY", () => {
    expect(assessMarketData(gut({ tier: "SECONDARY" })).kind).toBe("PASS");
  });
});

describe("Unplausible Werte sind Anbieterfehler, keine Marktaussage", () => {
  it("lehnt einen negativen Preis ab", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, priceUsd: -1 } }));
    expect(v.kind).toBe("IMPLAUSIBLE");
    if (v.kind === "IMPLAUSIBLE") expect(v.field).toBe("priceUsd");
  });

  it("lehnt einen Preis von 0 ab", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, priceUsd: 0 } }));
    expect(v.kind).toBe("IMPLAUSIBLE");
  });

  it("lehnt NaN ab", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: Number.NaN } }));
    expect(v.kind).toBe("IMPLAUSIBLE");
  });

  it("lehnt Infinity ab", () => {
    const v = assessMarketData(
      gut({ fields: { ...VOLLSTAENDIG, marketCapUsd: Number.POSITIVE_INFINITY } }),
    );
    expect(v.kind).toBe("IMPLAUSIBLE");
  });

  it("trennt unplausibel von zu klein", () => {
    const kaputt = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: -5 } }));
    const klein = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: 5 } }));
    expect(kaputt.kind).toBe("IMPLAUSIBLE");
    expect(klein.kind).toBe("BELOW_THRESHOLD");
  });
});

describe("Schwellen", () => {
  it("lehnt zu geringe Liquiditaet ab und nennt die Zahl", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: 100 } }));
    expect(v.kind).toBe("BELOW_THRESHOLD");
    if (v.kind === "BELOW_THRESHOLD") {
      expect(v.field).toBe("liquidityUsd");
      expect(v.reason).toContain(String(DEFAULT_QUALITY_THRESHOLDS.minLiquidityUsd));
    }
  });

  it("lehnt zu geringes Volumen ab", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, volume24hUsd: 10 } }));
    expect(v.kind).toBe("BELOW_THRESHOLD");
    if (v.kind === "BELOW_THRESHOLD") expect(v.field).toBe("volume24hUsd");
  });

  it("akzeptiert genau auf der Grenze", () => {
    const v = assessMarketData(
      gut({
        fields: {
          ...VOLLSTAENDIG,
          liquidityUsd: DEFAULT_QUALITY_THRESHOLDS.minLiquidityUsd,
          volume24hUsd: DEFAULT_QUALITY_THRESHOLDS.minVolume24hUsd,
        },
      }),
    );
    expect(v.kind).toBe("PASS");
  });

  it("laesst sich die Schwellen vorgeben", () => {
    const v = assessMarketData(
      gut({
        fields: { ...VOLLSTAENDIG, liquidityUsd: 100 },
        thresholds: { ...DEFAULT_QUALITY_THRESHOLDS, minLiquidityUsd: 50 },
      }),
    );
    expect(v.kind).toBe("PASS");
  });
});

describe("Begruendung", () => {
  it("nennt bei INCOMPLETE die fehlenden Felder", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: null } }));
    expect(explainVerdict(v)).toContain("liquidityUsd");
  });

  it("sagt bei BELOW_THRESHOLD ausdruecklich, dass gemessen wurde", () => {
    const v = assessMarketData(gut({ fields: { ...VOLLSTAENDIG, volume24hUsd: 1 } }));
    expect(explainVerdict(v)).toContain("Gemessen, nicht unbekannt");
  });

  it("liefert fuer jeden Fall einen nicht-leeren Satz", () => {
    const faelle: QualityInput[] = [
      gut(),
      gut({ tier: "FALLBACK" }),
      gut({ freshnessSeconds: 999 }),
      gut({ fields: { ...VOLLSTAENDIG, priceUsd: null } }),
      gut({ fields: { ...VOLLSTAENDIG, priceUsd: -1 } }),
      gut({ fields: { ...VOLLSTAENDIG, liquidityUsd: 1 } }),
    ];
    for (const f of faelle) {
      expect(explainVerdict(assessMarketData(f)).length).toBeGreaterThan(10);
    }
  });
});

describe("Der Gate selbst", () => {
  it("laesst nur PASS durch", () => {
    expect(marketDataSupportsEntry(gut())).toBe(true);
    expect(marketDataSupportsEntry(gut({ tier: "FALLBACK" }))).toBe(false);
    expect(marketDataSupportsEntry(gut({ freshnessSeconds: 999 }))).toBe(false);
    expect(
      marketDataSupportsEntry(gut({ fields: { ...VOLLSTAENDIG, priceUsd: null } })),
    ).toBe(false);
  });

  it("erzeugt ohne jede Marktdaten keine Gelegenheit", () => {
    const leer: MarketDataFields = {
      priceUsd: null, liquidityUsd: null, marketCapUsd: null, fdvUsd: null,
      volume24hUsd: null, buyCount24h: null, sellCount24h: null,
      buyVolume24hUsd: null, sellVolume24hUsd: null, tradeCount24h: null,
      uniqueWallets24h: null, holders: null,
    };
    expect(marketDataSupportsEntry(gut({ fields: leer }))).toBe(false);
  });
});
