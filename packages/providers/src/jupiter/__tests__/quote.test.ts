import { describe, expect, it } from "vitest";
import { bps, isMissing, isPresent, mint, providerId, FixedClock } from "@sae/core";
import { ProviderHttpClient } from "../../http";
import { TokenBucket } from "../../rate-limiter";
import { CircuitBreaker } from "../../circuit-breaker";
import { HealthTracker } from "../../health";
import { JupiterRouterProvider, decimalFractionToBps, toRouteQuote } from "../provider";
import { quoteResponseSchema } from "../schema";

/**
 * Vertragstests gegen die Jupiter Swap API v1.
 *
 * Die Fixtures sind aus der Hersteller-OpenAPI-Spezifikation ABGELEITET, nicht
 * aus echten Antworten aufgezeichnet — der API-Host war in dieser Umgebung
 * nicht erreichbar (siehe docs/providers/jupiter.md). Sie belegen deshalb, dass
 * der Adapter die SPEZIFIZIERTE Form korrekt verarbeitet, nicht dass der
 * Anbieter sich daran haelt.
 *
 * Genau dafuer gibt es die Laufzeitvalidierung: weicht eine echte Antwort ab,
 * fuehrt das zu MISSING(PARSE_FAILED) und einem sichtbaren Ausfall — nicht zu
 * still falsch interpretierten Zahlen.
 */

const T0 = new Date("2026-08-30T12:00:00Z");
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Aus der Spezifikation abgeleitet: alle Pflichtfelder, Betraege als Strings. */
const specQuote = {
  inputMint: SOL,
  inAmount: "1000000000",
  outputMint: USDC,
  outAmount: "148230000",
  otherAmountThreshold: "147783310",
  swapMode: "ExactIn",
  slippageBps: 30,
  priceImpactPct: "0.0012",
  routePlan: [
    {
      swapInfo: {
        ammKey: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
        label: "Raydium",
        inputMint: SOL,
        outputMint: USDC,
        inAmount: "1000000000",
        outAmount: "148230000",
      },
      percent: 100,
    },
  ],
  contextSlot: 301_234_567,
  timeTaken: 0.031,
};

function makeProvider(fetchImpl: typeof fetch) {
  const clock = new FixedClock(T0);
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30_000, clock });
  const health = new HealthTracker({ clock });
  const http = new ProviderHttpClient({
    providerId: providerId("jupiter"),
    clock,
    bucket: new TokenBucket({ capacity: 10, refillPerSecond: 1, clock }),
    breaker,
    health,
    fetchImpl,
  });
  return new JupiterRouterProvider({
    http,
    baseUrl: "https://api.jup.ag/swap/v1",
    health,
    breaker,
  });
}

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("Schema", () => {
  it("akzeptiert die spezifizierte Antwortform", () => {
    expect(quoteResponseSchema.safeParse(specQuote).success).toBe(true);
  });

  it("lehnt Betraege als Zahl statt String ab", () => {
    // Waeren sie Zahlen, verloeren grosse u64-Werte stillschweigend Stellen.
    const broken = { ...specQuote, outAmount: 148_230_000 };
    expect(quoteResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("lehnt eine fehlende Mindestausgabemenge ab", () => {
    const { otherAmountThreshold: _omitted, ...broken } = specQuote;
    expect(quoteResponseSchema.safeParse(broken).success).toBe(false);
  });
});

describe("decimalFractionToBps", () => {
  it("rechnet Dezimalbruch in Basispunkte um", () => {
    expect(decimalFractionToBps("0.0012")).toBe(12);
    expect(decimalFractionToBps("0.05")).toBe(500);
  });

  it("rundet zulasten der Kostenschaetzung auf", () => {
    expect(decimalFractionToBps("0.00125")).toBe(13);
  });

  it("rechnet einen negativen Impact nicht als Vorteil ein", () => {
    // Ein gerade guenstiges Routing ist keine Planungsgrundlage — im naechsten
    // Block gilt es nicht mehr.
    expect(decimalFractionToBps("-0.003")).toBe(0);
  });
});

describe("toRouteQuote", () => {
  it("bildet Betraege ohne Praezisionsverlust ab", () => {
    const huge = { ...specQuote, outAmount: "18446744073709551615" }; // u64-Maximum
    const quote = toRouteQuote(quoteResponseSchema.parse(huge));
    expect(quote.outAmount).toBe(18_446_744_073_709_551_615n);
  });

  it("uebernimmt Route-Labels", () => {
    expect(toRouteQuote(specQuote).routeLabels).toEqual(["Raydium"]);
  });

  it("faellt beim Label auf den AMM-Schluessel zurueck", () => {
    // `label` ist laut Spezifikation optional — ohne Ruecksicht darauf haetten
    // wir hier `undefined` als Routennamen im Trade-Log.
    const { label: _dropped, ...swapInfoWithoutLabel } = specQuote.routePlan[0]!.swapInfo;
    const noLabel = {
      ...specQuote,
      routePlan: [{ ...specQuote.routePlan[0]!, swapInfo: swapInfoWithoutLabel }],
    };
    expect(toRouteQuote(quoteResponseSchema.parse(noLabel)).routeLabels[0]).toMatch(/^58oQ/);
  });
});

describe("JupiterRouterProvider", () => {
  const request = {
    inputMint: mint(SOL),
    outputMint: mint(USDC),
    amount: 1_000_000_000n,
    slippageBps: bps(30),
  };

  it("liefert ein Quote als Observation", async () => {
    const provider = makeProvider(respond(specQuote));
    const result = await provider.getQuote(request);
    expect(isPresent(result)).toBe(true);
    if (isPresent(result)) {
      expect(result.value.outAmount).toBe(148_230_000n);
      expect(result.value.priceImpactBps).toBe(12);
      expect(result.value.quotedMinOutAmount).toBe(147_783_310n);
      expect(result.source).toBe("jupiter");
    }
  });

  it("baut die Anfrage nach der Spezifikation", async () => {
    let seen = "";
    const capturing = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify(specQuote), { status: 200 });
    }) as unknown as typeof fetch;

    await makeProvider(capturing).getQuote({ ...request, maxAccounts: 40 });
    expect(seen).toContain("/swap/v1/quote?");
    expect(seen).toContain(`inputMint=${SOL}`);
    expect(seen).toContain("amount=1000000000");
    expect(seen).toContain("slippageBps=30");
    expect(seen).toContain("maxAccounts=40");
  });

  it("liefert MISSING, wenn der Anbieter ausfaellt", async () => {
    const result = await makeProvider(respond({}, 503)).getQuote(request);
    expect(isMissing(result)).toBe(true);
  });

  it("liefert MISSING bei unerwarteter Antwortform", async () => {
    const result = await makeProvider(respond({ unerwartet: true })).getQuote(request);
    expect(isMissing(result)).toBe(true);
    if (isMissing(result)) expect(result.reason).toBe("PARSE_FAILED");
  });

  it("meldet den eigenen Gesundheitszustand", async () => {
    const provider = makeProvider(respond(specQuote));
    await provider.getQuote(request);
    expect(provider.health().status).toBe("HEALTHY");
    expect(provider.descriptor.verifiedAt).toBe("2026-08-30");
    expect(provider.descriptor.docsPath).toBe("docs/providers/jupiter.md");
  });
});
