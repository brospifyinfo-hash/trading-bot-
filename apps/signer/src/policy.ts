import { PolicyViolation } from "@sae/core";

/**
 * Signier-Policy.
 *
 * Der Kern der Signer-Isolation: diese Pruefungen laufen UNABHAENGIG vom Aufrufer.
 * Ein vollstaendig kompromittierter Execution-Worker kann dem Signer beliebige
 * Bytes schicken — er bekommt trotzdem nichts signiert, was hier durchfaellt.
 * Deshalb darf die Policy nichts glauben, was im Request steht, ausser den
 * Referenzen, die sie selbst gegen den Intent prueft.
 *
 * Die Transaktion kommt als normalisierte Struktur herein, nicht als Rohbytes.
 * Das Dekodieren ist Aufgabe eines Adapters (Phase 12) und bewusst getrennt:
 * die Policy ist damit ohne Solana-Bibliothek testbar, und ihre Regeln lassen
 * sich einzeln nachweisen.
 */

export interface SolTransfer {
  readonly from: string;
  readonly to: string;
  readonly lamports: bigint;
}

export interface DecodedTransaction {
  readonly feePayer: string;
  readonly programIds: readonly string[];
  readonly solTransfers: readonly SolTransfer[];
  /** Alle Mints, die die Transaktion beruehrt. */
  readonly tokenMints: readonly string[];
  /**
   * Garantierte Mindestausgabemenge aus der Swap-Instruktion.
   * `null` bedeutet: nicht gefunden — und damit unsignierbar.
   */
  readonly minOutAmount: bigint | null;
}

export interface SignRequest {
  readonly intentId: string;
  readonly transaction: DecodedTransaction;
}

export interface PolicyConfig {
  /** Programme, die ueberhaupt vorkommen duerfen. Alles andere: Ablehnung. */
  readonly allowedProgramIds: ReadonlySet<string>;
  /** Die einzige Wallet, die zahlen darf. */
  readonly tradingWallet: string;
  /** Empfaenger, die SOL direkt erhalten duerfen (z. B. Jito-Tip-Konten). */
  readonly allowedDirectRecipients: ReadonlySet<string>;
  readonly maxSolOutPerTxLamports: bigint;
  readonly maxSolOutPerWindowLamports: bigint;
  readonly windowMs: number;
}

/** Was der Signer vom Intent unabhaengig nachschlaegt — nicht aus dem Request. */
export interface IntentFacts {
  readonly expectedMint: string;
  readonly stillActive: boolean;
}

export type PolicyCheck =
  | "PROGRAM_NOT_ALLOWED"
  | "WRONG_FEE_PAYER"
  | "SOL_OUT_EXCEEDS_TX_LIMIT"
  | "SOL_OUT_EXCEEDS_WINDOW_LIMIT"
  | "UNEXPECTED_SOL_RECIPIENT"
  | "MINT_MISMATCH"
  | "MIN_OUT_MISSING"
  | "MIN_OUT_ZERO"
  | "INTENT_REPLAY"
  | "INTENT_NOT_ACTIVE";

export class SignerPolicy {
  readonly #config: PolicyConfig;
  readonly #seenIntents = new Set<string>();
  #window: Array<{ at: number; lamports: bigint }> = [];

  constructor(config: PolicyConfig) {
    this.#config = config;
  }

  /**
   * Wirft bei Verstoss. Gibt bei Erfolg den geprueften SOL-Abfluss zurueck.
   *
   * Reihenfolge ist Absicht: die billigen, eindeutigen Pruefungen zuerst, damit
   * eine Ablehnung einen praezisen Grund nennt statt eines Folgefehlers.
   */
  check(request: SignRequest, intent: IntentFacts, now: number): bigint {
    const tx = request.transaction;

    if (!intent.stillActive) {
      throw violation("INTENT_NOT_ACTIVE", "Intent ist nicht mehr aktiv", {
        intentId: request.intentId,
      });
    }

    // Replay: derselbe Intent darf nie zweimal signiert werden. Ohne diese Regel
    // genuegt ein wiederholter Request, um eine Position zu verdoppeln.
    if (this.#seenIntents.has(request.intentId)) {
      throw violation("INTENT_REPLAY", "Intent wurde bereits signiert", {
        intentId: request.intentId,
      });
    }

    for (const programId of tx.programIds) {
      if (!this.#config.allowedProgramIds.has(programId)) {
        throw violation("PROGRAM_NOT_ALLOWED", `Programm nicht zugelassen: ${programId}`, {
          programId,
        });
      }
    }

    if (tx.feePayer !== this.#config.tradingWallet) {
      throw violation("WRONG_FEE_PAYER", "Transaktion zahlt nicht aus der Trading-Wallet", {});
    }

    if (!tx.tokenMints.includes(intent.expectedMint)) {
      // Die Transaktion handelt einen anderen Token als den freigegebenen.
      throw violation("MINT_MISMATCH", "Transaktion beruehrt den erwarteten Mint nicht", {});
    }

    if (tx.minOutAmount === null) {
      throw violation("MIN_OUT_MISSING", "Keine garantierte Mindestausgabemenge gefunden", {});
    }
    if (tx.minOutAmount <= 0n) {
      // minOut = 0 heisst: jeder Ausgang ist akzeptabel, auch ein Totalverlust.
      throw violation("MIN_OUT_ZERO", "Mindestausgabemenge ist null — unbegrenzte Slippage", {});
    }

    let outflow = 0n;
    for (const transfer of tx.solTransfers) {
      if (transfer.from !== this.#config.tradingWallet) continue;
      if (
        !this.#config.allowedDirectRecipients.has(transfer.to) &&
        !this.#config.allowedProgramIds.has(transfer.to)
      ) {
        throw violation("UNEXPECTED_SOL_RECIPIENT", `SOL-Abfluss an ${transfer.to}`, {});
      }
      outflow += transfer.lamports;
    }

    if (outflow > this.#config.maxSolOutPerTxLamports) {
      throw violation("SOL_OUT_EXCEEDS_TX_LIMIT", "SOL-Abfluss ueber dem Transaktionslimit", {});
    }

    this.#pruneWindow(now);
    const windowTotal = this.#window.reduce((sum, e) => sum + e.lamports, 0n) + outflow;
    if (windowTotal > this.#config.maxSolOutPerWindowLamports) {
      throw violation(
        "SOL_OUT_EXCEEDS_WINDOW_LIMIT",
        "SOL-Abfluss ueber dem Zeitfensterlimit",
        {},
      );
    }

    this.#seenIntents.add(request.intentId);
    this.#window.push({ at: now, lamports: outflow });
    return outflow;
  }

  #pruneWindow(now: number): void {
    const cutoff = now - this.#config.windowMs;
    this.#window = this.#window.filter((e) => e.at > cutoff);
  }
}

function violation(
  check: PolicyCheck,
  message: string,
  context: Record<string, unknown>,
): PolicyViolation {
  return new PolicyViolation(check, message, context);
}
