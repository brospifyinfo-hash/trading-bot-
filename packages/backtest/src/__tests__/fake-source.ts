import { missing, observed, providerId, tokenId as toTokenId, type Maybe, type TokenId } from "@sae/core";
import type { FeatureVector } from "@sae/scoring";
import type { PositionMarketState } from "@sae/trading";
import type { BacktestDataSource } from "../sources";

const SRC = providerId("fixture");

/**
 * Datenquelle fuer Tests.
 *
 * Sie fuehrt jede angefragte `asOf` mit und WIRFT, wenn der Harness je einen
 * Zeitpunkt jenseits der zuletzt gesetzten Simulationszeit anfragt. Damit ist der
 * No-Look-Ahead-Test nicht die Pruefung eines Rueckgabewerts, sondern eine
 * Falle: eine Verletzung laesst den Lauf abstuerzen, statt ein schoenes Ergebnis
 * zu liefern.
 */
export class RecordingSource implements BacktestDataSource {
  readonly requestedAsOf: Date[] = [];
  #hardLimit: Date | null = null;

  constructor(
    private readonly prices: ReadonlyMap<number, number>,
    private readonly options: {
      readonly universe?: readonly TokenId[];
      readonly liquidityUsd?: number;
      readonly volumeAcceleration?: number;
    } = {},
  ) {}

  /** Setzt die Obergrenze, jenseits derer jede Anfrage ein Fehler ist. */
  setHardLimit(at: Date): void {
    this.#hardLimit = at;
  }

  #record(asOf: Date): void {
    this.requestedAsOf.push(new Date(asOf.getTime()));
    if (this.#hardLimit !== null && asOf > this.#hardLimit) {
      throw new Error(
        `Look-Ahead: Anfrage fuer ${asOf.toISOString()} jenseits von ${this.#hardLimit.toISOString()}`,
      );
    }
  }

  #priceAt(asOf: Date): number | null {
    const minute = Math.floor(asOf.getTime() / 60_000);
    return this.prices.get(minute) ?? null;
  }

  async universeAt(asOf: Date): Promise<readonly TokenId[]> {
    this.#record(asOf);
    return this.options.universe ?? [toTokenId("token-1")];
  }

  async featuresAt(tokenId: TokenId, asOf: Date): Promise<FeatureVector | null> {
    this.#record(asOf);
    const price = this.#priceAt(asOf);
    if (price === null) return null;
    const val = <T>(v: T): Maybe<T> => observed(v, SRC, asOf);
    const gone = <T>(): Maybe<T> => missing("NOT_YET_COLLECTED", asOf, SRC);
    return {
      tokenId,
      asOf,
      security: {
        mintAuthorityActive: val(false),
        freezeAuthorityActive: val(false),
        lpBurnedOrLocked: val(true),
        top10HolderSharePct: val(15),
        topHolderSharePct: val(4),
        riskLevel: val("LOW" as const),
      },
      market: {
        priceUsd: val(price),
        liquidityUsd: val(this.options.liquidityUsd ?? 150_000),
        marketCapUsd: val(1_500_000),
        volume24hUsd: val(500_000),
        tokenAgeSeconds: val(7_200),
      },
      momentum: {
        priceChange5m: val(0.2),
        priceChange1h: val(0.5),
        volumeAcceleration: val(this.options.volumeAcceleration ?? 2.6),
        buys5m: val(220),
        sells5m: val(60),
      },
      holder: {
        holders: val(2_600),
        holderGrowth: val(320),
        distinctActors: val(2_400),
        largestClusterSharePct: val(7),
      },
      execution: {
        expectedCostBps: val(160),
        exitCapacityRatio: val(8),
        priceImpactBps: val(70),
      },
      pending: {
        smartMoneyBuyers: val(7),
        smartMoneySellers: val(0),
        socialAuthenticity: val(78),
        socialMomentum: val(74),
        devScore: val(72),
        narrativeScore: gone(),
      },
    };
  }

  async positionMarketAt(
    _tokenId: TokenId,
    entryPriceUsd: number,
    _entryLiquidityUsd: number,
    highWaterRatio: number,
    holdingSeconds: number,
    asOf: Date,
  ): Promise<PositionMarketState | null> {
    this.#record(asOf);
    const price = this.#priceAt(asOf);
    if (price === null) return null;
    const priceRatio = price / entryPriceUsd;
    return {
      priceRatio,
      highWaterRatio: Math.max(highWaterRatio, priceRatio),
      volumeAcceleration: this.options.volumeAcceleration ?? 2.6,
      buyRatio: 0.6,
      liquidityRatio: 1,
      smartMoneySellers: 0,
      devSold: false,
      securityDowngraded: false,
      holdingSeconds,
    };
  }

  async quoteAt(
    _tokenId: TokenId,
    notionalMinor: bigint,
    asOf: Date,
  ): Promise<{ outAmount: bigint; priceImpactBps: number } | null> {
    this.#record(asOf);
    if (this.#priceAt(asOf) === null) return null;
    return { outAmount: notionalMinor * 1_000n, priceImpactBps: 70 };
  }
}

/** Preisreihe je Minute ab `start`, als Faktor auf den Startpreis. */
export function priceSeries(start: Date, factors: readonly number[], base = 1): Map<number, number> {
  const map = new Map<number, number>();
  const startMinute = Math.floor(start.getTime() / 60_000);
  factors.forEach((factor, i) => map.set(startMinute + i, base * factor));
  return map;
}
