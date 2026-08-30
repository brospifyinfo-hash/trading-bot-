import type { Mint, PoolAddress, TokenId, WalletAddress } from "./ids";
import type { Score } from "./decision";
import type { Maybe } from "./observation";

export type TokenLifecycleState =
  | "DISCOVERED"
  | "SCREENING"
  | "ENRICHING"
  | "SCORED"
  | "CANDIDATE"
  | "WATCHLIST"
  | "DECIDED"
  | "REJECTED";

export interface Token {
  readonly tokenId: TokenId;
  readonly mint: Mint;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number;
  readonly firstSeenAt: Date;
  readonly launchedAt: Date | null;
  readonly state: TokenLifecycleState;
}

export type Dex = "raydium" | "orca" | "meteora" | "pumpswap" | "unknown";

export interface TokenPool {
  readonly address: PoolAddress;
  readonly dex: Dex;
  readonly baseMint: Mint;
  readonly quoteMint: Mint;
  /** Reserven in kleinster Einheit des jeweiligen Mints. */
  readonly baseReserve: bigint;
  readonly quoteReserve: bigint;
  readonly feeBps: number;
  readonly createdAt: Date | null;
}

/**
 * Marktzustand eines Tokens zu einem Zeitpunkt.
 *
 * Jedes Feld ist `Maybe`, weil in der Praxis regelmaessig einzelne Provider
 * ausfallen. Ein fehlendes Feld senkt die Datenvollstaendigkeit — es wird nicht
 * durch eine Zahl ersetzt.
 */
export interface TokenMarket {
  readonly priceUsd: Maybe<number>;
  readonly marketCapUsd: Maybe<number>;
  readonly liquidityUsd: Maybe<number>;
  readonly volume24hUsd: Maybe<number>;
  readonly holders: Maybe<number>;
  readonly buys5m: Maybe<number>;
  readonly sells5m: Maybe<number>;
}

export interface TokenSecuritySummary {
  readonly mintAuthorityActive: Maybe<boolean>;
  readonly freezeAuthorityActive: Maybe<boolean>;
  readonly lpBurnedOrLocked: Maybe<boolean>;
  readonly topHolderShare: Maybe<number>;
  readonly top10HolderShare: Maybe<number>;
  readonly devWallet: Maybe<WalletAddress>;
}

/**
 * Der vollstaendige Zustand, den das System zu einem Zeitpunkt ueber einen Token
 * kannte. Grundlage jedes Backtests und jeder Forensik: "was wussten wir um 12:00?"
 */
export interface TokenSnapshot {
  readonly tokenId: TokenId;
  /** Wann WIR diesen Zustand beobachtet haben. Der Backtest-Filter. */
  readonly observedAt: Date;
  readonly market: TokenMarket;
  readonly security: TokenSecuritySummary;
  readonly finalScore: Score | null;
  readonly dataCompleteness: number;
  readonly scoreEngineVersion: string | null;
}
