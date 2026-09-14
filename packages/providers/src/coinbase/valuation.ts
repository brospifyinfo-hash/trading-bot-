import { money, mulDiv, type Clock, type Currency, type Money } from "@sae/core";

interface Decimal { readonly n: bigint; readonly d: bigint }
export interface FiatTicker {
  readonly bid: Decimal;
  readonly ask: Decimal;
  readonly observedAt: Date;
  readonly product: string;
}

function decimal(input: unknown): Decimal | null {
  if (typeof input !== "string" || !/^\d{1,12}(\.\d{1,12})?$/.test(input)) return null;
  const [whole, fraction = ""] = input.split(".");
  const n = BigInt(`${whole}${fraction}`);
  return n > 0n ? { n, d: 10n ** BigInt(fraction.length) } : null;
}

/** Reference fiat valuation only. This adapter never places an exchange order. */
export class CoinbaseFiatValuation {
  private readonly cache = new Map<string, { at: number; request: Promise<FiatTicker | null> }>();
  constructor(private readonly clock: Clock, private readonly fetchImpl: typeof fetch = fetch) {}

  async ticker(asset: "USDC" | "SOL", currency: Currency): Promise<FiatTicker | null> {
    const product = `${asset}-${currency}`;
    const now = this.clock.now().getTime();
    let cached = this.cache.get(product);
    if (cached === undefined || now < cached.at || now - cached.at >= 30_000) {
      cached = { at: now, request: this.fetchTicker(product) };
      this.cache.set(product, cached);
    }
    const result = await cached.request;
    if (result === null) return null;
    const age = this.clock.now().getTime() - result.observedAt.getTime();
    return age >= 0 && age < 120_000 ? result : null;
  }

  private async fetchTicker(product: string): Promise<FiatTicker | null> {
    try {
      const response = await this.fetchImpl(`https://api.exchange.coinbase.com/products/${product}/ticker`, {
        signal: AbortSignal.timeout(5_000), headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null) return null;
      const row = body as Record<string, unknown>;
      const bid = decimal(row["bid"]);
      const ask = decimal(row["ask"]);
      if (bid === null || ask === null || bid.n * ask.d > ask.n * bid.d || typeof row["time"] !== "string") return null;
      const observedAt = new Date(row["time"]);
      if (!Number.isFinite(observedAt.getTime())) return null;
      return { bid, ask, observedAt, product };
    } catch { return null; }
  }
}

/** Integer conversion from mint raw units; proceeds floor, expense reference ceil. */
export function valueTokenRaw(raw: bigint, decimals: number, ticker: FiatTicker, currency: Currency, side: "bid" | "ask"): Money {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !ticker.product.endsWith(`-${currency}`)) {
    throw new RangeError("Invalid fiat valuation units");
  }
  const rate = ticker[side];
  return money(mulDiv(raw, rate.n * 100n, rate.d * 10n ** BigInt(decimals), side === "bid" ? "floor" : "ceil"), currency);
}
