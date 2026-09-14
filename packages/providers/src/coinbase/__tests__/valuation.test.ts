import { describe, expect, it } from "vitest";
import { FixedClock, eur } from "@sae/core";
import { CoinbaseFiatValuation, valueTokenRaw } from "../valuation";

const now = new Date("2026-09-14T12:00:00Z");
const body = { bid: "0.85001", ask: "0.85009", time: now.toISOString() };

describe("fiat reference valuation", () => {
  it("uses exact decimal conversion and shares concurrent ticker requests", async () => {
    let calls = 0;
    const source = new CoinbaseFiatValuation(new FixedClock(now), async () => { calls++; return Response.json(body); });
    const [a, b] = await Promise.all([source.ticker("USDC", "EUR"), source.ticker("USDC", "EUR")]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    if (a === null) throw new Error("Fixture");
    expect(valueTokenRaw(100_000_000n, 6, a, "EUR", "bid")).toEqual(eur(85));
    expect(valueTokenRaw(100_000_000n, 6, a, "EUR", "ask")).toEqual(eur(85.01));
    expect(() => valueTokenRaw(1n, 6, a, "USD", "bid")).toThrow();
  });
  it("rejects expired and future timestamps, malformed prices and crossed spreads", async () => {
    for (const row of [
      { ...body, time: "2026-09-14T11:57:00Z" },
      { ...body, time: "2026-09-14T12:01:00Z" },
      { ...body, time: "unknown" }, { ...body, bid: "NaN" },
      { ...body, bid: "0" }, { ...body, bid: "1.2", ask: "1.1" },
    ]) {
      const source = new CoinbaseFiatValuation(new FixedClock(now), async () => Response.json(row));
      expect(await source.ticker("USDC", "EUR")).toBeNull();
    }
  });
  it("leaves provider failures unknown instead of substituting parity", async () => {
    const source = new CoinbaseFiatValuation(new FixedClock(now), async () => new Response("rate limited", { status: 429 }));
    expect(await source.ticker("USDC", "EUR")).toBeNull();
  });
});
