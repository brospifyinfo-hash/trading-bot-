import { expect, it } from "vitest";
import { FixedClock, eur } from "@sae/core";
import { CoinbaseFiatValuation } from "@sae/providers";
import { buildPaperValuation } from "../paper-valuation";
import { QUOTE_ANCHOR_MINT } from "../quote-market-source";

it("values router output using read mint decimals and independently sourced fiat prices", async () => {
  const at = new Date("2026-09-14T12:00:00Z");
  const clock = new FixedClock(at);
  const source = new CoinbaseFiatValuation(clock, async (url) => Response.json({
    bid: String(url).includes("SOL-") ? "120" : "0.9",
    ask: String(url).includes("SOL-") ? "121" : "0.91", time: at.toISOString(),
  }));
  const load = buildPaperValuation({}, clock, { source, decimalsOf: async (mint) => mint === QUOTE_ANCHOR_MINT ? 6 : null });
  const valuation = await load("EUR");
  expect(valuation?.solPrice).toEqual(eur(121));
  const fill = { amountRaw: 10_000_000n, mint: QUOTE_ANCHOR_MINT, currency: "EUR" as const, at };
  expect((await valuation?.valueFill(fill))?.proceeds).toEqual(eur(9));
  expect(await valuation?.valueFill({ ...fill, mint: "other" })).toBeNull();
  expect(await valuation?.valueFill({ ...fill, at: new Date(at.getTime() + 120_000) })).toBeNull();
});
