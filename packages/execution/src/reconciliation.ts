import type { Clock, Mint, TxSignature, WalletAddress } from "@sae/core";
import type { ChainState, WalletBalances } from "./chain-state";

/**
 * Abgleich zwischen interner Buchhaltung und Chain.
 *
 * Grundsatz: eine gesendete Transaktion gilt NIE als erfolgreich, nur weil sie
 * gesendet wurde. Zwischen "abgeschickt" und "bestaetigt" liegt ein Zustand, den
 * die meisten Systeme nicht kennen — und in dem sie deshalb raten.
 *
 * Der Reconciler raet nicht. Er loest auf oder er wartet.
 */

export type SignatureResolution =
  | { readonly kind: "CONFIRMED"; readonly slot: number; readonly confirmedAt: Date }
  | { readonly kind: "FAILED"; readonly error: string }
  /** Weiterhin offen. Ausdruecklich NICHT dasselbe wie fehlgeschlagen. */
  | { readonly kind: "STILL_UNKNOWN"; readonly ageMs: number; readonly attempts: number }
  /**
   * So alt, dass der Blockhash abgelaufen sein muss. Erst JETZT darf daraus ein
   * Fehlschlag werden — nicht weil wir es nicht wissen, sondern weil die
   * Transaktion nach Ablauf des Blockhashs nicht mehr eingebracht werden kann.
   */
  | { readonly kind: "EXPIRED_UNCONFIRMABLE"; readonly ageMs: number };

/**
 * Nach dieser Zeit kann eine nicht gefundene Transaktion nicht mehr durchgehen.
 * Solana-Blockhashes gelten rund 150 Slots; mit Sicherheitsaufschlag.
 */
export const BLOCKHASH_LIFETIME_MS = 120_000;

export async function resolveSignature(input: {
  readonly signature: TxSignature;
  readonly submittedAt: Date;
  readonly attempts: number;
  readonly chain: ChainState;
  readonly clock: Clock;
}): Promise<SignatureResolution> {
  const status = await input.chain.signatureStatus(input.signature);
  const ageMs = input.clock.now().getTime() - input.submittedAt.getTime();

  if (status.kind === "CONFIRMED") {
    return { kind: "CONFIRMED", slot: status.slot, confirmedAt: status.confirmedAt };
  }
  if (status.kind === "FAILED") {
    return { kind: "FAILED", error: status.error };
  }

  // NOT_FOUND. Frueher Zeitpunkt: der Knoten hat sie schlicht noch nicht gesehen.
  // Sie hier als fehlgeschlagen zu werten, waere der Fehler, der die doppelte
  // Position erzeugt.
  if (ageMs < BLOCKHASH_LIFETIME_MS) {
    return { kind: "STILL_UNKNOWN", ageMs, attempts: input.attempts };
  }
  return { kind: "EXPIRED_UNCONFIRMABLE", ageMs };
}

export interface InternalPosition {
  readonly positionId: string;
  readonly mint: Mint;
  /** Menge, die wir laut eigener Buchhaltung halten. */
  readonly expectedAmountRaw: bigint;
}

export type DriftKind =
  | "BALANCE_DRIFT"
  | "ORPHAN_ON_CHAIN_POSITION"
  | "MISSING_ON_CHAIN_POSITION";

export interface DriftEvent {
  readonly kind: DriftKind;
  readonly mint: Mint;
  readonly positionId: string | null;
  readonly expectedRaw: bigint;
  readonly actualRaw: bigint;
  /** Abweichung relativ zur erwarteten Menge, in Basispunkten. */
  readonly driftBps: number;
  readonly material: boolean;
}

export interface ReconciliationResult {
  readonly events: readonly DriftEvent[];
  /**
   * Bei materieller Abweichung wird ALLES angehalten — auch Verkaeufe. Wenn
   * interner und tatsaechlicher Bestand auseinanderlaufen, ist jede weitere
   * Order ein Schuss ins Dunkle.
   */
  readonly haltAllTrading: boolean;
  readonly checkedAt: Date;
}

/**
 * Ab welcher relativen Abweichung eine Differenz als materiell gilt.
 *
 * Kleine Abweichungen sind normal: Transferabgaben, Rundung bei Rebasing-Tokens,
 * ein noch nicht verbuchter Teilverkauf. Eine harte Gleichheitspruefung wuerde
 * das System staendig anhalten und damit unbenutzbar machen — was am Ende dazu
 * fuehrt, dass jemand die Pruefung abschaltet.
 */
export const MATERIAL_DRIFT_BPS = 100;

export function reconcilePositions(input: {
  readonly internal: readonly InternalPosition[];
  readonly balances: WalletBalances;
  readonly clock: Clock;
  readonly materialDriftBps?: number;
}): ReconciliationResult {
  const threshold = input.materialDriftBps ?? MATERIAL_DRIFT_BPS;
  const events: DriftEvent[] = [];
  const accountedMints = new Set<Mint>();

  for (const position of input.internal) {
    accountedMints.add(position.mint);
    const actual = input.balances.tokens.get(position.mint) ?? 0n;
    const expected = position.expectedAmountRaw;

    if (actual === expected) continue;

    if (actual === 0n && expected > 0n) {
      // Wir glauben zu halten, halten aber nichts. Immer materiell — entweder
      // wurde ohne unser Wissen verkauft, oder der Einstieg ist nie erfolgt.
      events.push({
        kind: "MISSING_ON_CHAIN_POSITION",
        mint: position.mint,
        positionId: position.positionId,
        expectedRaw: expected,
        actualRaw: 0n,
        driftBps: 10_000,
        material: true,
      });
      continue;
    }

    const diff = actual > expected ? actual - expected : expected - actual;
    const driftBps = expected === 0n ? 10_000 : Number((diff * 10_000n) / expected);
    events.push({
      kind: "BALANCE_DRIFT",
      mint: position.mint,
      positionId: position.positionId,
      expectedRaw: expected,
      actualRaw: actual,
      driftBps,
      material: driftBps >= threshold,
    });
  }

  // Bestaende, von denen die Buchhaltung nichts weiss. Das ist der gefaehrlichere
  // Fall: eine Position, die niemand ueberwacht, hat weder Stop noch Take Profit.
  for (const [mint, amount] of input.balances.tokens) {
    if (amount === 0n || accountedMints.has(mint)) continue;
    events.push({
      kind: "ORPHAN_ON_CHAIN_POSITION",
      mint,
      positionId: null,
      expectedRaw: 0n,
      actualRaw: amount,
      driftBps: 10_000,
      material: true,
    });
  }

  return {
    events,
    haltAllTrading: events.some((e) => e.material),
    checkedAt: input.clock.now(),
  };
}

/** Wallets, die regelmaessig abgeglichen werden muessen. */
export interface ReconciliationTarget {
  readonly wallet: WalletAddress;
  readonly positions: readonly InternalPosition[];
}
