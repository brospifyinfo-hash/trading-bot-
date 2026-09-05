import { describe, expect, it } from "vitest";
import { mint, poolAddress, type Mint } from "@sae/core";

import {
  DEFAULT_MARKET_SELECTION,
  selectMarket,
  type MarketCandidate,
  type MarketSelectionSettings,
} from "../market-selection";

/**
 * Die Auswahl des Marktes.
 *
 * Der Test, auf den es ankommt, steht im Block „Deterministisch": dieselben
 * Kandidaten in anderer Reihenfolge muessen dieselbe Wahl ergeben. Ohne das
 * haengt die wichtigste Kennzahl des Systems an der Sortierung einer
 * Anbieterantwort — und ein Backtest stellt die Auswahl nicht nach.
 */

/** Der Memecoin, um den es geht — bewusst verschieden von den Quote-Assets. */
const TOKEN = mint("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const SOL = mint("So11111111111111111111111111111111111111112");
const USDC = mint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const FREMD = mint("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr");

const NOW = new Date("2026-09-03T12:00:00Z");
const FRISCH = new Date(NOW.getTime() - 10_000);
const ALT_GENUG = new Date(NOW.getTime() - 6 * 60 * 60 * 1_000);

const settings: MarketSelectionSettings = {
  ...DEFAULT_MARKET_SELECTION,
  allowedQuoteMints: [SOL, USDC],
};

/**
 * Erzeugt gueltige, unterscheidbare Base58-Pool-Adressen.
 *
 * Base58 kennt weder `0` noch `O`, `I`, `l` — ein naives `padStart(4, "0")`
 * erzeugt also Adressen, die `poolAddress()` zu Recht ablehnt. Genau dafuer
 * ist die Pruefung da.
 */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = 0;
function adresse(): ReturnType<typeof poolAddress> {
  n += 1;
  const a = B58[n % B58.length] ?? "1";
  const b = B58[Math.floor(n / B58.length) % B58.length] ?? "1";
  return poolAddress(`Mkt${a}${b}${"z".repeat(38)}`);
}

function pool(over: Partial<MarketCandidate> = {}): MarketCandidate {
  return {
    poolAddress: adresse(),
    dex: "raydium",
    baseMint: TOKEN,
    quoteMint: USDC,
    priceUsd: 0.00042,
    liquidityUsd: 180_000,
    volume24hUsd: 95_000,
    buyCount24h: 812,
    sellCount24h: 640,
    pairCreatedAt: ALT_GENUG,
    observedAt: FRISCH,
    ...over,
  };
}

const waehle = (candidates: readonly MarketCandidate[], m: Mint = TOKEN) =>
  selectMarket({ mint: m, candidates, now: NOW, settings });

describe("Mehrere Pools, eine Wahl", () => {
  it("nimmt den tiefsten Pool, nicht den ersten", () => {
    // Die Falle, gegen die diese Datei gebaut ist: der erste in der Antwort
    // ist der duennste.
    const duenn = pool({ liquidityUsd: 8_000, volume24hUsd: 500_000 });
    const tief = pool({ liquidityUsd: 240_000, volume24hUsd: 90_000 });

    const s = waehle([duenn, tief]);
    expect(s.chosen?.poolAddress).toBe(tief.poolAddress);
  });

  it("bevorzugt Liquiditaet vor Volumen", () => {
    // Volumen ist die manipulierbarste Zahl im Datensatz; Liquiditaet
    // bestimmt, ob die Position wieder aufloesbar ist.
    const vielVolumen = pool({ liquidityUsd: 20_000, volume24hUsd: 900_000 });
    const vielLiquiditaet = pool({ liquidityUsd: 300_000, volume24hUsd: 40_000 });

    expect(waehle([vielVolumen, vielLiquiditaet]).chosen?.poolAddress).toBe(
      vielLiquiditaet.poolAddress,
    );
  });

  it("zieht bei gleicher Liquiditaet das Volumen heran", () => {
    const wenig = pool({ liquidityUsd: 100_000, volume24hUsd: 10_000 });
    const viel = pool({ liquidityUsd: 100_000, volume24hUsd: 80_000 });
    expect(waehle([wenig, viel]).chosen?.poolAddress).toBe(viel.poolAddress);
  });

  it("haelt alle zugelassenen Maerkte in Rangfolge fest", () => {
    const a = pool({ liquidityUsd: 50_000 });
    const b = pool({ liquidityUsd: 150_000 });
    const c = pool({ liquidityUsd: 90_000 });

    const s = waehle([a, b, c]);
    expect(s.ranked.map((m) => m.liquidityUsd)).toEqual([150_000, 90_000, 50_000]);
  });
});

describe("Deterministisch", () => {
  it("waehlt unabhaengig von der Eingabereihenfolge dasselbe", () => {
    const pools = [
      pool({ liquidityUsd: 50_000 }),
      pool({ liquidityUsd: 150_000 }),
      pool({ liquidityUsd: 90_000 }),
    ];
    const vorwaerts = waehle(pools).chosen?.poolAddress;
    const rueckwaerts = waehle([...pools].reverse()).chosen?.poolAddress;
    expect(vorwaerts).toBe(rueckwaerts);
  });

  it("entscheidet auch bei voellig gleichen Kennzahlen reproduzierbar", () => {
    // Zwei Pools, in allem gleich ausser der Adresse. Ohne letzten
    // Entscheider haette hier die Anbieterreihenfolge entschieden.
    const a = pool({ liquidityUsd: 100_000, volume24hUsd: 50_000 });
    const b = pool({ liquidityUsd: 100_000, volume24hUsd: 50_000 });

    const erste = waehle([a, b]).chosen?.poolAddress;
    const zweite = waehle([b, a]).chosen?.poolAddress;
    expect(erste).toBe(zweite);
    expect(erste).toBe(a.poolAddress < b.poolAddress ? a.poolAddress : b.poolAddress);
  });
});

describe("Ausschluesse — jeder mit eigenem Grund", () => {
  it("weist einen Pool ab, der einen anderen Token handelt", () => {
    const s = waehle([pool({ baseMint: FREMD })]);
    expect(s.chosen).toBeNull();
    expect(s.rejected[0]?.rejection).toBe("WRONG_BASE_TOKEN");
  });

  it("weist ein Quote-Asset ohne USD-Anker ab", () => {
    // Memecoin gegen Memecoin: beide Seiten bewegen sich, der USD-Preis
    // haengt an der Bewertung der Gegenseite.
    const s = waehle([pool({ quoteMint: FREMD })]);
    expect(s.rejected[0]?.rejection).toBe("UNUSABLE_QUOTE");
  });

  it("unterscheidet fehlende Liquiditaet von zu geringer", () => {
    const fehlt = waehle([pool({ liquidityUsd: null })]);
    const klein = waehle([pool({ liquidityUsd: 100 })]);
    expect(fehlt.rejected[0]?.rejection).toBe("NO_LIQUIDITY_REPORTED");
    expect(klein.rejected[0]?.rejection).toBe("LIQUIDITY_TOO_LOW");
  });

  it("weist veraltete Beobachtungen ab", () => {
    const s = waehle([pool({ observedAt: new Date(NOW.getTime() - 900_000) })]);
    expect(s.rejected[0]?.rejection).toBe("STALE");
  });

  it("behandelt einen fehlenden Anbieterzeitpunkt als veraltet, nicht als frisch", () => {
    // Der wichtigste Fall bei DexScreener: kein Beobachtungszeitpunkt in der
    // Antwort. Ihn durch den Empfangszeitpunkt zu ersetzen waere eine
    // Erfindung mit Folgen bis in den Backtest.
    const s = waehle([pool({ observedAt: null })]);
    expect(s.rejected[0]?.rejection).toBe("STALE");
  });

  it("laesst denselben Pool fuer die Historie zu", () => {
    // Die Historie darf mehr sehen als die Entscheidung: der Snapshot traegt
    // ohnehin unseren eigenen PIT-Stempel. Das ist eine schwaechere, aber
    // wahre Aussage — und ohne sie gaebe es nie eine Zeitreihe.
    const s = selectMarket({
      mint: TOKEN,
      candidates: [pool({ observedAt: null })],
      now: NOW,
      settings: { ...settings, requireProviderTimestamp: false },
    });
    expect(s.chosen).not.toBeNull();
  });

  it("prueft das Alter auch im Historienpfad, wenn ein Zeitstempel da ist", () => {
    // „Kein Zeitstempel" abzuschalten heisst nicht, einen vorhandenen zu
    // ignorieren.
    const s = selectMarket({
      mint: TOKEN,
      candidates: [pool({ observedAt: new Date(NOW.getTime() - 900_000) })],
      now: NOW,
      settings: { ...settings, requireProviderTimestamp: false },
    });
    expect(s.rejected[0]?.rejection).toBe("STALE");
  });

  it("weist zu junge Pools ab und unbekanntes Alter ebenso", () => {
    const jung = waehle([pool({ pairCreatedAt: new Date(NOW.getTime() - 60_000) })]);
    const unbekannt = waehle([pool({ pairCreatedAt: null })]);
    expect(jung.rejected[0]?.rejection).toBe("POOL_TOO_YOUNG");
    expect(unbekannt.rejected[0]?.rejection).toBe("POOL_TOO_YOUNG");
  });

  it("weist negative und nicht endliche Werte als Anbieterfehler ab", () => {
    for (const kaputt of [
      pool({ priceUsd: -1 }),
      pool({ liquidityUsd: Number.NaN }),
      pool({ volume24hUsd: Number.POSITIVE_INFINITY }),
      pool({ buyCount24h: -5 }),
      pool({ priceUsd: 0 }),
    ]) {
      expect(waehle([kaputt]).rejected[0]?.rejection).toBe("IMPLAUSIBLE_VALUE");
    }
  });
});

describe("Manipulationsindikatoren", () => {
  it("weist unmoeglichen Umschlag ab", () => {
    // 5 000 USD Liquiditaet, 2 Mio. USD Tagesvolumen: der Bestand waere
    // 400-mal umgeschlagen worden.
    const s = waehle([pool({ liquidityUsd: 5_000, volume24hUsd: 2_000_000 })]);
    expect(s.rejected[0]?.rejection).toBe("TURNOVER_IMPLAUSIBLE");
  });

  it("laesst hohen, aber erklaerbaren Umschlag zu", () => {
    // Bei Memecoins ist das Zehnfache der Liquiditaet an einem Tag normal.
    const s = waehle([pool({ liquidityUsd: 100_000, volume24hUsd: 1_000_000 })]);
    expect(s.chosen).not.toBeNull();
  });

  it("weist einen Markt ohne Verkaeufe ab", () => {
    const s = waehle([pool({ buyCount24h: 500, sellCount24h: 2, volume24hUsd: 80_000 })]);
    expect(s.rejected[0]?.rejection).toBe("ONE_SIDED_FLOW");
  });

  it("weist eine reine Ausstiegswelle ab", () => {
    const s = waehle([pool({ buyCount24h: 1, sellCount24h: 400, volume24hUsd: 80_000 })]);
    expect(s.rejected[0]?.rejection).toBe("ONE_SIDED_FLOW");
    expect(s.rejected[0]?.detail).toContain("Ausstiegswelle");
  });

  it("liest wenig Handel nicht als Manipulation", () => {
    // 20:0 bei 300 USD Tagesvolumen ist wenig Handel, kein Befund.
    const s = waehle([pool({ buyCount24h: 20, sellCount24h: 0, volume24hUsd: 300 })]);
    expect(s.chosen).not.toBeNull();
  });

  it("erfindet aus fehlenden Zaehlern keinen Befund", () => {
    const s = waehle([pool({ buyCount24h: null, sellCount24h: null })]);
    expect(s.chosen).not.toBeNull();
  });
});

describe("Aufzeichnung", () => {
  it("haelt jede Ablehnung mit Grund und Kennzahlen fest", () => {
    const s = waehle([
      pool({ liquidityUsd: 100 }),
      pool({ quoteMint: FREMD }),
      pool({ liquidityUsd: 200_000 }),
    ]);

    expect(s.chosen).not.toBeNull();
    expect(s.rejected).toHaveLength(2);
    for (const r of s.rejected) {
      expect(r.detail.length).toBeGreaterThan(10);
      expect(r.poolAddress).toBeTruthy();
      expect(r.dex).toBe("raydium");
    }
  });

  it("nennt bei vollstaendigem Ausschluss die Gruende gezaehlt", () => {
    const s = waehle([pool({ liquidityUsd: 100 }), pool({ liquidityUsd: 200 })]);
    expect(s.chosen).toBeNull();
    expect(s.reason).toContain("LIQUIDITY_TOO_LOW=2");
  });

  it("unterscheidet 'nichts gemeldet' von 'nichts bestanden'", () => {
    expect(waehle([]).reason).toContain("Keine Maerkte");
    expect(waehle([pool({ liquidityUsd: 1 })]).reason).toContain("Kein Markt bestand");
  });

  it("haelt den Auswahlzeitpunkt fest", () => {
    expect(waehle([pool()]).selectedAt).toEqual(NOW);
  });
});
