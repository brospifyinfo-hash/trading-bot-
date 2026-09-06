import { describe, expect, it } from "vitest";
import type { Clock } from "@sae/core";

import {
  buildMarketAdapters,
  createRejectionTally,
  USD_ANCHOR_QUOTE_MINTS,
} from "../market-adapters";

/**
 * Die Brücke vom Anbieter in die Kette.
 *
 * Zwei Zusicherungen tragen diese Datei, und beide betreffen Fehler, die im
 * Betrieb unsichtbar waeren:
 *
 * 1. Bei mehreren Pools wird **nicht der erste** genommen.
 * 2. Es entsteht **kein** Beobachtungszeitpunkt, den der Anbieter nicht
 *    geliefert hat.
 */

const T0 = new Date("2026-09-05T12:00:00Z");
const fixedClock: Clock = { now: () => T0 };

const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL_DUENN = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const POOL_TIEF = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";

/** Alt genug fuer die Pool-Altersgrenze. */
const ALT = T0.getTime() - 6 * 60 * 60 * 1_000;

function pair(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: POOL_TIEF,
    baseToken: { address: MEME, symbol: "MEME" },
    quoteToken: { address: USDC, symbol: "USDC" },
    priceUsd: "0.00042",
    txns: { h24: { buys: 812, sells: 640 } },
    volume: { h24: 95_000 },
    liquidity: { usd: 180_000, base: 1, quote: 2 },
    pairCreatedAt: ALT,
    ...over,
  };
}

/** Ein Adapter, dessen fetch eine vorgegebene Antwort liefert. */
function adapterWith(body: string, status = 200) {
  const fetchImpl = (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

  // Der Adapter wird ueber die Abbildung gebaut; fuer den Test wird der
  // fetch-Aufruf im inneren Adapter ersetzt. Dafuer reicht der oeffentliche
  // Weg nicht aus, deshalb hier die Abbildung mit eigener Basis-URL und ein
  // ueberschriebenes globales fetch.
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const adapters = buildMarketAdapters({
    env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
    clock: fixedClock,
  });
  return {
    adapter: adapters.get("dexscreener")!,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function fetchMarket(body: string, status = 200) {
  const { adapter, restore } = adapterWith(body, status);
  try {
    return await adapter.fetchMarket(MEME);
  } finally {
    restore();
  }
}

describe("Vom Anbieter in die Kette", () => {
  it("liefert den gewaehlten Markt als Kettenwert", async () => {
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out).not.toBeNull();
    expect(out?.value.priceUsd).toBe(0.00042);
    expect(out?.value.liquidityUsd).toBe(180_000);
    expect(out?.value.volume24hUsd).toBe(95_000);
  });

  it("nimmt bei mehreren Pools NICHT den ersten", async () => {
    // Der duenne Pool steht vorn in der Antwort. Genau die Falle.
    const body = JSON.stringify([
      pair({ pairAddress: POOL_DUENN, liquidity: { usd: 9_000 }, priceUsd: "0.00099" }),
      pair({ pairAddress: POOL_TIEF, liquidity: { usd: 400_000 }, priceUsd: "0.00042" }),
    ]);
    const out = await fetchMarket(body);
    expect(out?.value.liquidityUsd).toBe(400_000);
    expect(out?.value.priceUsd).toBe(0.00042);
  });

  it("erfindet keinen Beobachtungszeitpunkt", async () => {
    // DexScreener liefert keinen. Der Abrufzeitpunkt ist kein Ersatz — er
    // waere eine behauptete Frische und truege bis in jeden Backtest.
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out?.observedAt).toBeNull();
  });

  it("laesst marketCap null, wenn der Anbieter es nicht liefert", async () => {
    const out = await fetchMarket(JSON.stringify([pair()]));
    expect(out?.value.marketCapUsd).toBeNull();
  });

  it("reicht marketCap durch, wenn es geliefert wird", async () => {
    const out = await fetchMarket(JSON.stringify([pair({ marketCap: 2_400_000 })]));
    expect(out?.value.marketCapUsd).toBe(2_400_000);
  });
});

describe("Was nicht durchkommt", () => {
  it("liefert nichts, wenn kein Pool die Pruefung besteht", async () => {
    // Zu wenig Liquiditaet.
    const out = await fetchMarket(JSON.stringify([pair({ liquidity: { usd: 100 } })]));
    expect(out).toBeNull();
  });

  it("liefert nichts bei einem Quote-Asset ohne USD-Anker", async () => {
    const out = await fetchMarket(
      JSON.stringify([pair({ quoteToken: { address: MEME, symbol: "MEME" } })]),
    );
    expect(out).toBeNull();
  });

  it("verwirft Pools mit unbrauchbarer Adresse", async () => {
    // Keine Base58-Adresse. Kommt so etwas an, ist es ein Anbieterfehler oder
    // etwas Schlimmeres — in beiden Faellen keine Grundlage.
    const out = await fetchMarket(JSON.stringify([pair({ pairAddress: "nicht base58!!" })]));
    expect(out).toBeNull();
  });

  it("liefert nichts bei einer Antwort, die nicht zum Vertrag passt", async () => {
    const out = await fetchMarket('[{"chainId":"solana"}]');
    expect(out).toBeNull();
  });

  it("liefert nichts bei HTTP-Fehler", async () => {
    expect(await fetchMarket("nope", 503)).toBeNull();
  });

  it("liefert nichts bei leerer Antwort", async () => {
    expect(await fetchMarket("[]")).toBeNull();
  });

  it("fragt gar nicht erst bei unbrauchbarer Mint-Adresse", async () => {
    const { adapter, restore } = adapterWith(JSON.stringify([pair()]));
    try {
      expect(await adapter.fetchMarket("keine adresse")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Quote-Anker", () => {
  it("fuehrt SOL, USDC und USDT", () => {
    expect(USD_ANCHOR_QUOTE_MINTS).toHaveLength(3);
    expect(USD_ANCHOR_QUOTE_MINTS).toContain(USDC);
  });
});

describe("Warum kein Markt gewaehlt wurde", () => {
  /**
   * `fetchMarket` kann nur `null` sagen. Der Grund — den `selectMarket` genau
   * kennt — endete damit an dieser Stelle, und im Betrieb blieb die Auskunft
   * „noSource: 9": neun Token ohne Daten, ohne ein Wort dazu, warum. Die
   * Ablage traegt ihn heraus, ohne den Adapter-Vertrag zu aendern.
   */
  function mitAblage(body: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
    const rejections = createRejectionTally();
    const adapters = buildMarketAdapters({
      env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
      clock: fixedClock,
      rejections,
    });
    return {
      adapter: adapters.get("dexscreener")!,
      rejections,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  it("nennt den Ausschlussgrund, statt ihn zu verschlucken", async () => {
    // Ein Pool, der zu jung ist: die Auswahl verlangt 15 Minuten, dieser ist
    // eine Minute alt. Genau der Fall, der bei frischen Memecoins haeufig ist.
    const jung = JSON.stringify([
      pair({ pairCreatedAt: T0.getTime() - 60 * 1_000 }),
    ]);
    const { adapter, rejections, restore } = mitAblage(jung);
    try {
      expect(await adapter.fetchMarket(MEME)).toBeNull();
    } finally {
      restore();
    }

    const counts = rejections.drain();
    expect(counts.tokens).toBe(1);
    expect(counts.reasons["POOL_TOO_YOUNG"]).toBe(1);
  });

  it("meldet auch den Fall, dass der Anbieter gar keinen Pool kennt", async () => {
    const { adapter, rejections, restore } = mitAblage("[]");
    try {
      expect(await adapter.fetchMarket(MEME)).toBeNull();
    } finally {
      restore();
    }
    const counts = rejections.drain();
    // Kein Pool ist etwas anderes als ein abgelehnter Pool. Beides als
    // „kein Markt" zu zaehlen waere richtig, aber nicht auskunftsfaehig.
    expect(counts.reasons["NO_POOL_REPORTED"]).toBe(1);
  });

  it("leert sich beim Auslesen", async () => {
    const { adapter, rejections, restore } = mitAblage("[]");
    try {
      await adapter.fetchMarket(MEME);
    } finally {
      restore();
    }
    expect(rejections.drain().tokens).toBe(1);
    // Sonst summierte sich der Zaehler ueber alle Laeufe hinweg auf und das
    // Log meldete jedes Mal die Gruende von gestern mit.
    expect(rejections.drain().tokens).toBe(0);
  });
});

describe("Wogegen der Pool gehandelt hat", () => {
  /**
   * Der Ausschlussgrund allein beantwortet die entscheidende Frage nicht.
   * Zehn Pools gegen EINE Gegenwaehrung heisst womoeglich: uns fehlt ein
   * legitimer Anker. Zehn Pools gegen zehn verschiedene Memecoins heisst: der
   * Filter hat recht. Ohne diese Auszaehlung sieht beides gleich aus.
   */
  function mitAblage(body: string) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => body }) as unknown as Response) as typeof fetch;
    const rejections = createRejectionTally();
    const adapters = buildMarketAdapters({
      env: { DEXSCREENER_BASE_URL: "https://api.example.invalid" },
      clock: fixedClock,
      rejections,
    });
    return {
      adapter: adapters.get("dexscreener")!,
      rejections,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  }

  const FREMD = "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr";

  it("nennt das Symbol der abgelehnten Gegenwaehrung", async () => {
    const body = JSON.stringify([
      pair({ quoteToken: { address: FREMD, symbol: "BONK" } }),
    ]);
    const { adapter, rejections, restore } = mitAblage(body);
    try {
      expect(await adapter.fetchMarket(MEME)).toBeNull();
    } finally {
      restore();
    }
    const counts = rejections.drain();
    expect(counts.reasons["UNUSABLE_QUOTE"]).toBe(1);
    expect(counts.quotes["BONK"]).toBe(1);
  });

  it("nimmt die Adresse, wenn kein Symbol dabei ist", async () => {
    const body = JSON.stringify([pair({ quoteToken: { address: FREMD } })]);
    const { adapter, rejections, restore } = mitAblage(body);
    try {
      await adapter.fetchMarket(MEME);
    } finally {
      restore();
    }
    // Gekuerzt auf 16 Zeichen, aber eindeutig genug zum Nachschlagen.
    expect(Object.keys(rejections.drain().quotes)[0]).toBe(FREMD.slice(0, 16));
  });

  it("laesst ein bosartiges Symbol nicht die Log-Zeile zerlegen", async () => {
    // Symbole waehlt der Token-Ersteller. Ein Zeilenumbruch darin macht aus
    // einer Log-Zeile zwei, und die zweite sieht aus wie ein echter Eintrag.
    const body = JSON.stringify([
      pair({ quoteToken: { address: FREMD, symbol: 'X\nMarktdaten aufgefrischt ingested="999"' } }),
    ]);
    const { adapter, rejections, restore } = mitAblage(body);
    try {
      await adapter.fetchMarket(MEME);
    } finally {
      restore();
    }
    const key = Object.keys(rejections.drain().quotes)[0] ?? "";
    expect(key).not.toContain("\n");
    expect(key).not.toContain('"');
    expect(key).not.toContain(" ");
  });
});
