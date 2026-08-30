import { isPresent, type Bps, type Maybe, type Mint, type Money, type WalletAddress } from "@sae/core";
import type { ExecutionCostEstimate } from "@sae/simulation";
import type { WalletBalances } from "./chain-state";

/**
 * Pruefung unmittelbar vor der Ausfuehrung.
 *
 * Die letzte Stelle, an der ein Fehler noch kostenlos ist. Danach kostet er Geld.
 *
 * Sie prueft NICHT, ob der Trade eine gute Idee ist — das haben Score, Gates und
 * Erwartungswert erledigt. Sie prueft, ob die Transaktion, die gleich gebaut wird,
 * das tut, was der Intent sagt. Zwei verschiedene Fragen, und die Vermischung
 * beider ist der Grund, warum viele Systeme an dieser Stelle nur oberflaechlich
 * pruefen.
 */

export type PreTradeFailure =
  | "WRONG_WALLET"
  | "WRONG_OUTPUT_MINT"
  | "AMOUNT_OUT_OF_BOUNDS"
  | "MIN_OUT_MISSING"
  | "MIN_OUT_ZERO"
  | "MIN_OUT_INCONSISTENT_WITH_SLIPPAGE"
  | "INSUFFICIENT_SOL_FOR_TRADE"
  | "INSUFFICIENT_SOL_FOR_FEES"
  | "QUOTE_STALE"
  | "INTENT_EXPIRED"
  | "POSITION_ALREADY_HELD"
  /** Verkauf ohne ausreichenden Bestand — der Ausstieg wuerde on-chain scheitern. */
  | "INSUFFICIENT_TOKEN_BALANCE"
  | "CHAIN_STATE_STALE"
  | "COSTS_EXCEED_EDGE";

export interface PreTradeInput {
  /**
   * Kauf oder Verkauf.
   *
   * Der Unterschied ist nicht kosmetisch: beim Kauf ist die Eingabemenge SOL
   * und der Zielbestand muss LEER sein, beim Verkauf ist die Eingabemenge der
   * Token und der Bestand muss REICHEN. Eine Validierung, die nur den Kauf
   * kennt, laesst den Ausstieg ungeprueft durch — also genau den Pfad, auf den
   * es im Ernstfall ankommt.
   */
  readonly side: "buy" | "sell";
  readonly expectedWallet: WalletAddress;
  /** Der Token, um den es geht. Beim Kauf Ausgabe, beim Verkauf Eingabe. */
  readonly expectedTokenMint: Mint;
  readonly intentExpiresAt: Date;

  readonly quote: {
    readonly inputMint: Mint;
    readonly outputMint: Mint;
    readonly inAmount: bigint;
    readonly outAmount: bigint;
    readonly minOutAmount: bigint | null;
    readonly slippageBps: Bps;
    readonly quotedAt: Date;
  };

  /**
   * Geplante Eingabemenge laut Intent, in der kleinsten Einheit des
   * Eingabe-Mints: Lamports beim Kauf, Token-Einheiten beim Verkauf.
   */
  readonly plannedInAmount: bigint;
  /** Wie weit der tatsaechliche Einsatz davon abweichen darf. */
  readonly amountToleranceBps: Bps;

  readonly balances: WalletBalances;
  /** Reserve, damit die Wallet nicht auf null faellt und Konten mietfrei bleiben. */
  readonly rentBufferLamports: bigint;

  readonly costs: ExecutionCostEstimate;
  /** Erwarteter Vorteil dieses Trades. `MISSING`, solange der EV unbekannt ist. */
  readonly expectedEdge: Maybe<Money>;

  readonly quoteMaxAgeMs: number;
  readonly chainStateMaxAgeMs: number;
  readonly now: Date;
}

export interface PreTradeResult {
  readonly ok: boolean;
  readonly failures: readonly PreTradeFailure[];
  /** Gesamter SOL-Abfluss, der gleich passieren wird. Fuer die Signer-Policy. */
  readonly totalLamportsOut: bigint;
}

export function validatePreTrade(input: PreTradeInput): PreTradeResult {
  const failures: PreTradeFailure[] = [];

  if (input.balances.wallet !== input.expectedWallet) failures.push("WRONG_WALLET");

  // Beim Kauf muss der Token herauskommen, beim Verkauf hineingehen.
  const tokenSideMint =
    input.side === "buy" ? input.quote.outputMint : input.quote.inputMint;
  if (tokenSideMint !== input.expectedTokenMint) failures.push("WRONG_OUTPUT_MINT");

  if (input.now >= input.intentExpiresAt) failures.push("INTENT_EXPIRED");
  if (input.now.getTime() - input.quote.quotedAt.getTime() > input.quoteMaxAgeMs) {
    failures.push("QUOTE_STALE");
  }
  // Ein alter Kontostand ist genauso gefaehrlich wie ein altes Quote: er kann
  // bereits durch eine andere Transaktion verbraucht sein.
  if (input.now.getTime() - input.balances.readAt.getTime() > input.chainStateMaxAgeMs) {
    failures.push("CHAIN_STATE_STALE");
  }

  const tolerance = (input.plannedInAmount * BigInt(input.amountToleranceBps)) / 10_000n;
  const delta =
    input.quote.inAmount > input.plannedInAmount
      ? input.quote.inAmount - input.plannedInAmount
      : input.plannedInAmount - input.quote.inAmount;
  if (delta > tolerance) failures.push("AMOUNT_OUT_OF_BOUNDS");

  if (input.quote.minOutAmount === null) {
    failures.push("MIN_OUT_MISSING");
  } else if (input.quote.minOutAmount <= 0n) {
    // minOut = 0 heisst: jeder Ausgang ist akzeptabel, auch ein Totalverlust.
    failures.push("MIN_OUT_ZERO");
  } else {
    // Die Untergrenze muss zur angegebenen Slippage passen. Weicht sie ab, hat
    // jemand entweder den Quote oder die Toleranz veraendert — beides ist ein
    // Grund, nicht zu handeln.
    const expectedMin =
      (input.quote.outAmount * BigInt(10_000 - input.quote.slippageBps)) / 10_000n;
    const lowerBound = (expectedMin * 99n) / 100n;
    if (input.quote.minOutAmount < lowerBound) {
      failures.push("MIN_OUT_INCONSISTENT_WITH_SLIPPAGE");
    }
  }

  /**
   * Der Guthabencheck deckt BEIDES ab: den Handelsbetrag UND die Gebuehren.
   * Nur den Handelsbetrag zu pruefen ist der klassische Fehler — die
   * Transaktion scheitert dann on-chain, kostet trotzdem Gebuehren, und im
   * Log steht ein nichtssagender Programmfehler.
   */
  const feeLamports =
    input.costs.networkFeeLamports + input.costs.priorityFeeLamports + input.costs.tipLamports;
  const held = input.balances.tokens.get(input.expectedTokenMint) ?? 0n;

  // Beim Kauf fliesst SOL ab, beim Verkauf nur die Gebuehren.
  const totalLamportsOut =
    input.side === "buy" ? input.quote.inAmount + feeLamports : feeLamports;

  if (input.side === "buy") {
    if (input.balances.lamports < input.quote.inAmount) {
      failures.push("INSUFFICIENT_SOL_FOR_TRADE");
    } else if (input.balances.lamports < totalLamportsOut + input.rentBufferLamports) {
      failures.push("INSUFFICIENT_SOL_FOR_FEES");
    }
    // Vierte Ebene des Duplikatschutzes, direkt vor dem Signieren: haelt die
    // Wallet den Token bereits, ist vorher etwas schiefgegangen.
    if (held > 0n) failures.push("POSITION_ALREADY_HELD");
  } else {
    // Ein Verkauf kostet kein SOL ausser den Gebuehren — aber ohne SOL fuer die
    // Gebuehren kommt man aus einer Position nicht heraus. Das ist die Falle,
    // in die eine voll investierte Wallet laeuft.
    if (input.balances.lamports < feeLamports + input.rentBufferLamports) {
      failures.push("INSUFFICIENT_SOL_FOR_FEES");
    }
    if (held < input.quote.inAmount) failures.push("INSUFFICIENT_TOKEN_BALANCE");
  }

  // Kosten gegen erwarteten Vorteil. Ist der Vorteil unbekannt, wird hier NICHT
  // abgelehnt — die Entscheidung darueber faellt in der Decision-Engine, die den
  // Modus kennt. Zweimal an verschiedenen Stellen dieselbe Regel zu pruefen
  // fuehrt dazu, dass sie irgendwann auseinanderlaufen.
  if (isPresent(input.expectedEdge)) {
    if (input.costs.total.currency !== input.expectedEdge.value.currency) {
      throw new TypeError("Kosten und erwarteter Vorteil in verschiedenen Waehrungen");
    }
    if (input.costs.total.minor >= input.expectedEdge.value.minor) {
      failures.push("COSTS_EXCEED_EDGE");
    }
  }

  return { ok: failures.length === 0, failures, totalLamportsOut };
}
