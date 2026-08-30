import { missing, observed, providerId, mint as toMint, type Maybe, type Mint } from "@sae/core";
import type { DiscoveredToken, DiscoverySource, DiscoveryTrigger } from "../types";

export const T0 = new Date("2026-08-30T12:00:00Z");
export const SRC_A = providerId("source-a");
export const SRC_B = providerId("source-b");

export const val = <T>(v: T): Maybe<T> => observed(v, SRC_A, T0);
export const gone = <T>(): Maybe<T> => missing("NOT_SUPPORTED_BY_PROVIDER", T0, SRC_A);

/** Gueltige, aber offensichtlich erfundene Base58-Adressen fuer Tests. */
export const mintOf = (n: number): Mint => toMint(`${String(n).padStart(2, "1")}${"A".repeat(40)}`);

export function discovered(overrides: Partial<DiscoveredToken> = {}): DiscoveredToken {
  return {
    mint: mintOf(1),
    trigger: "NEW_PAIR",
    source: SRC_A,
    observedAt: T0,
    launchedAt: new Date(T0.getTime() - 3_600_000),
    symbol: "TEST",
    poolAddress: null,
    liquidityUsd: val(80_000),
    marketCapUsd: val(900_000),
    ...overrides,
  };
}

export function fakeSource(
  id = SRC_A,
  tokens: readonly DiscoveredToken[] = [discovered()],
  trigger: DiscoveryTrigger = "NEW_PAIR",
): DiscoverySource {
  return { id, trigger, discover: async () => observed(tokens, id, T0) };
}

export function failingSource(id = SRC_B): DiscoverySource {
  return {
    id,
    trigger: "VOLUME_SPIKE",
    discover: async () => missing("PROVIDER_DOWN", T0, id),
  };
}
