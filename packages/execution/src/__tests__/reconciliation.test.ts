import { describe, expect, it } from "vitest";
import { FixedClock, mint as toMint, txSignature, walletAddress } from "@sae/core";
import type { ChainState, SignatureStatus, WalletBalances } from "../chain-state";
import {
  BLOCKHASH_LIFETIME_MS,
  MATERIAL_DRIFT_BPS,
  reconcilePositions,
  resolveSignature,
  type InternalPosition,
} from "../reconciliation";

const T0 = new Date("2026-08-30T12:00:00Z");
const WALLET = walletAddress("TradingWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
const TOKEN_A = toMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_B = toMint("So11111111111111111111111111111111111111112");
const SIG = txSignature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
);

const chainWith = (status: SignatureStatus): ChainState => ({
  balances: async () => ({
    wallet: WALLET,
    lamports: 0n,
    tokens: new Map(),
    slot: 1,
    readAt: T0,
  }),
  signatureStatus: async () => status,
});

const balances = (tokens: ReadonlyMap<string, bigint>): WalletBalances => ({
  wallet: WALLET,
  lamports: 1_000_000_000n,
  tokens: tokens as ReadonlyMap<never, bigint>,
  slot: 300_000_000,
  readAt: T0,
});

describe("resolveSignature", () => {
  const base = { signature: SIG, submittedAt: T0, attempts: 1 };

  it("loest eine bestaetigte Transaktion auf", async () => {
    const result = await resolveSignature({
      ...base,
      chain: chainWith({ kind: "CONFIRMED", slot: 42, confirmedAt: T0 }),
      clock: new FixedClock(new Date(T0.getTime() + 5_000)),
    });
    expect(result.kind).toBe("CONFIRMED");
  });

  it("loest eine fehlgeschlagene Transaktion auf", async () => {
    const result = await resolveSignature({
      ...base,
      chain: chainWith({ kind: "FAILED", error: "custom program error 0x1771" }),
      clock: new FixedClock(new Date(T0.getTime() + 5_000)),
    });
    expect(result.kind).toBe("FAILED");
  });

  it("wertet eine kurz zuvor gesendete, unbekannte Transaktion NICHT als Fehlschlag", async () => {
    // Der entscheidende Test: der Knoten hat sie schlicht noch nicht gesehen.
    // Sie hier als fehlgeschlagen zu werten, erzeugt die doppelte Position.
    const result = await resolveSignature({
      ...base,
      chain: chainWith({ kind: "NOT_FOUND" }),
      clock: new FixedClock(new Date(T0.getTime() + 3_000)),
    });
    expect(result.kind).toBe("STILL_UNKNOWN");
  });

  it("bleibt bis kurz vor Ablauf des Blockhashs bei UNKNOWN", async () => {
    const result = await resolveSignature({
      ...base,
      chain: chainWith({ kind: "NOT_FOUND" }),
      clock: new FixedClock(new Date(T0.getTime() + BLOCKHASH_LIFETIME_MS - 1_000)),
    });
    expect(result.kind).toBe("STILL_UNKNOWN");
  });

  it("erklaert sie erst nach Ablauf des Blockhashs fuer unbestaetigbar", async () => {
    // Nicht weil wir es nicht wissen, sondern weil die Transaktion danach nicht
    // mehr eingebracht werden kann. Das ist ein Unterschied.
    const result = await resolveSignature({
      ...base,
      chain: chainWith({ kind: "NOT_FOUND" }),
      clock: new FixedClock(new Date(T0.getTime() + BLOCKHASH_LIFETIME_MS + 1_000)),
    });
    expect(result.kind).toBe("EXPIRED_UNCONFIRMABLE");
  });

  it("zaehlt die Versuche mit", async () => {
    const result = await resolveSignature({
      ...base,
      attempts: 7,
      chain: chainWith({ kind: "NOT_FOUND" }),
      clock: new FixedClock(new Date(T0.getTime() + 1_000)),
    });
    if (result.kind === "STILL_UNKNOWN") expect(result.attempts).toBe(7);
  });
});

describe("reconcilePositions", () => {
  const clock = new FixedClock(T0);
  const position = (mint: string, expected: bigint): InternalPosition => ({
    positionId: `pos-${mint.slice(0, 4)}`,
    mint: mint as never,
    expectedAmountRaw: expected,
  });

  it("meldet nichts, wenn alles uebereinstimmt", () => {
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000n)],
      balances: balances(new Map([[TOKEN_A, 1_000n]])),
      clock,
    });
    expect(result.events).toEqual([]);
    expect(result.haltAllTrading).toBe(false);
  });

  it("toleriert eine kleine Abweichung", () => {
    // Transferabgaben, Rundung, ein noch nicht verbuchter Teilverkauf. Eine
    // harte Gleichheitspruefung wuerde das System staendig anhalten — und am
    // Ende schaltet jemand die Pruefung ab.
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000_000n)],
      balances: balances(new Map([[TOKEN_A, 999_950n]])),
      clock,
    });
    expect(result.events[0]!.material).toBe(false);
    expect(result.haltAllTrading).toBe(false);
  });

  it("meldet eine materielle Abweichung", () => {
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000_000n)],
      balances: balances(new Map([[TOKEN_A, 800_000n]])),
      clock,
    });
    expect(result.events[0]!.kind).toBe("BALANCE_DRIFT");
    expect(result.events[0]!.material).toBe(true);
    expect(result.events[0]!.driftBps).toBeGreaterThanOrEqual(MATERIAL_DRIFT_BPS);
  });

  it("meldet eine verschwundene Position immer als materiell", () => {
    // Entweder wurde ohne unser Wissen verkauft, oder der Einstieg ist nie
    // erfolgt. Beides ist gravierend.
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000n)],
      balances: balances(new Map()),
      clock,
    });
    expect(result.events[0]!.kind).toBe("MISSING_ON_CHAIN_POSITION");
    expect(result.haltAllTrading).toBe(true);
  });

  it("meldet einen unbekannten Bestand als verwaisste Position", () => {
    // Der gefaehrlichere Fall: eine Position, die niemand ueberwacht, hat weder
    // Stop noch Take Profit.
    const result = reconcilePositions({
      internal: [],
      balances: balances(new Map([[TOKEN_B, 5_000n]])),
      clock,
    });
    expect(result.events[0]!.kind).toBe("ORPHAN_ON_CHAIN_POSITION");
    expect(result.haltAllTrading).toBe(true);
  });

  it("ignoriert Nullbestaende", () => {
    const result = reconcilePositions({
      internal: [],
      balances: balances(new Map([[TOKEN_B, 0n]])),
      clock,
    });
    expect(result.events).toEqual([]);
  });

  it("haelt bei materieller Abweichung ALLES an, nicht nur Einstiege", () => {
    // Wenn interner und tatsaechlicher Bestand auseinanderlaufen, ist auch ein
    // Verkauf ein Schuss ins Dunkle.
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000_000n)],
      balances: balances(new Map([[TOKEN_A, 1n]])),
      clock,
    });
    expect(result.haltAllTrading).toBe(true);
  });

  it("prueft mehrere Positionen unabhaengig", () => {
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000n), position(TOKEN_B, 2_000n)],
      balances: balances(new Map([[TOKEN_A, 1_000n], [TOKEN_B, 500n]])),
      clock,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.mint).toBe(TOKEN_B);
  });

  it("erkennt auch einen zu HOHEN Bestand", () => {
    // Ein unerwarteter Zufluss ist ebenfalls eine Abweichung — vielleicht wurde
    // zweimal gekauft.
    const result = reconcilePositions({
      internal: [position(TOKEN_A, 1_000n)],
      balances: balances(new Map([[TOKEN_A, 2_000n]])),
      clock,
    });
    expect(result.events[0]!.kind).toBe("BALANCE_DRIFT");
    expect(result.events[0]!.material).toBe(true);
  });
});
