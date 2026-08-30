/**
 * Branded IDs.
 *
 * Auf Solana sind Mint-, Pool-, Wallet- und Programm-Adressen alle base58-Strings
 * gleicher Gestalt. Ohne Branding sind sie beliebig vertauschbar — und eine
 * vertauschte Adresse im Execution-Pfad ist ein Totalverlust, kein Bug-Ticket.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TokenId = Brand<string, "TokenId">;
export type Mint = Brand<string, "Mint">;
export type PoolAddress = Brand<string, "PoolAddress">;
export type WalletAddress = Brand<string, "WalletAddress">;
export type ProgramId = Brand<string, "ProgramId">;
export type IntentId = Brand<string, "IntentId">;
export type PositionId = Brand<string, "PositionId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type DecisionId = Brand<string, "DecisionId">;
export type StrategyVersionId = Brand<string, "StrategyVersionId">;
export type TxSignature = Brand<string, "TxSignature">;

/** Base58-Alphabet nach Bitcoin-Konvention (ohne 0, O, I, l). */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Solana-Adressen sind 32 Byte, base58-kodiert also 32–44 Zeichen.
 * Diese Pruefung validiert die Gestalt, nicht die Existenz on-chain.
 */
export function isBase58Address(value: string): boolean {
  return value.length >= 32 && value.length <= 44 && BASE58.test(value);
}

function assertAddress(value: string, label: string): void {
  if (!isBase58Address(value)) {
    throw new TypeError(`Ungueltige ${label}: ${JSON.stringify(value)}`);
  }
}

export function mint(value: string): Mint {
  assertAddress(value, "Mint-Adresse");
  return value as Mint;
}

export function poolAddress(value: string): PoolAddress {
  assertAddress(value, "Pool-Adresse");
  return value as PoolAddress;
}

export function walletAddress(value: string): WalletAddress {
  assertAddress(value, "Wallet-Adresse");
  return value as WalletAddress;
}

export function programId(value: string): ProgramId {
  assertAddress(value, "Programm-ID");
  return value as ProgramId;
}

/** Transaktionssignaturen sind 64 Byte → base58 rund 87–88 Zeichen. */
export function txSignature(value: string): TxSignature {
  if (value.length < 64 || value.length > 90 || !BASE58.test(value)) {
    throw new TypeError(`Ungueltige Transaktionssignatur: ${JSON.stringify(value)}`);
  }
  return value as TxSignature;
}

export const tokenId = (v: string): TokenId => v as TokenId;
export const intentId = (v: string): IntentId => v as IntentId;
export const positionId = (v: string): PositionId => v as PositionId;
export const executionId = (v: string): ExecutionId => v as ExecutionId;
export const decisionId = (v: string): DecisionId => v as DecisionId;
export const strategyVersionId = (v: string): StrategyVersionId => v as StrategyVersionId;
