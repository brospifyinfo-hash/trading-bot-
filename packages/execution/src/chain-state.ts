import type { Mint, TxSignature, WalletAddress } from "@sae/core";

/**
 * Sicht auf den tatsaechlichen Zustand der Chain.
 *
 * Bewusst als Schnittstelle: die Implementierung braucht RPC, die Logik darueber
 * nicht. So laesst sich das gesamte Sicherheitsnetz testen, ohne eine
 * Netzverbindung — und ohne dass ein Test versehentlich echtes Geld bewegt.
 */

export interface WalletBalances {
  readonly wallet: WalletAddress;
  readonly lamports: bigint;
  /** Token-Bestaende in kleinster Einheit, je Mint. */
  readonly tokens: ReadonlyMap<Mint, bigint>;
  /** Slot, zu dem der Zustand gelesen wurde. */
  readonly slot: number;
  readonly readAt: Date;
}

export type SignatureStatus =
  | { readonly kind: "CONFIRMED"; readonly slot: number; readonly confirmedAt: Date }
  | { readonly kind: "FAILED"; readonly error: string }
  /** Der Knoten kennt die Signatur nicht — noch nicht, oder nie. */
  | { readonly kind: "NOT_FOUND" };

export interface ChainState {
  balances(wallet: WalletAddress): Promise<WalletBalances>;
  signatureStatus(signature: TxSignature): Promise<SignatureStatus>;
}
