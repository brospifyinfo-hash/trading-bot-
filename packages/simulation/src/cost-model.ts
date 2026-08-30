import {
  applyBps,
  bps,
  formatMoney,
  isPresent,
  money,
  mulDiv,
  type Bps,
  type Currency,
  type Maybe,
  type Missing,
  type MissingReason,
  type Money,
  type Result,
  err,
  ok,
} from "@sae/core";

/**
 * Ausfuehrungskosten.
 *
 * EIN Modell fuer Paper Trading, Backtest und den Live-Pre-Trade-Check. Drei
 * getrennte Implementierungen wuerden auseinanderdriften, und dann sagt die
 * Paper-Statistik nichts mehr ueber den Live-Betrieb aus.
 *
 * Alle Parameter sind Annahmen, bis sie gegen reale Ausfuehrungen kalibriert sind
 * (siehe `calibration.ts`). Keiner der Defaults ist gemessen.
 */

export const LAMPORTS_PER_SIGNATURE = 5_000n;

export interface FeeAssumptions {
  readonly signatureCount: number;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: number;
  /** Jito-Tip in Lamports. 0, wenn ohne Bundles gehandelt wird. */
  readonly tipLamports: bigint;
  /**
   * Anteil der Transaktionen, die on-chain fehlschlagen (Slippage ueberschritten,
   * Blockhash abgelaufen). Kostet Gebuehren ohne Gegenwert.
   */
  readonly failureRate: number;
}

export interface LatencyAssumptions {
  /** Erwartete Zeit zwischen Quote und tatsaechlichem Fill. */
  readonly quoteToFillMs: number;
  /**
   * Angenommene ungünstige Preisdrift pro Sekunde, in Basispunkten.
   * Bei Memecoins ist das der groesste und am schlechtesten bekannte Posten —
   * Startwert bewusst pessimistisch, bis gemessen.
   */
  readonly adverseDriftBpsPerSecond: number;
}

export interface CostModelInputs {
  /** Handelsvolumen dieser Ausfuehrung in Portfoliowaehrung. */
  readonly notional: Money;
  /** Pool-/Router-Gebuehr. */
  readonly dexFeeBps: Bps;
  /** Preis-Impact aus dem Quote oder der Pool-Naeherung. */
  readonly priceImpactBps: Bps;
  /** Preis von 1 SOL in Portfoliowaehrung. */
  readonly solPrice: Money;
  readonly fees: FeeAssumptions;
  readonly latency: LatencyAssumptions;
}

export interface ExecutionCostEstimate {
  readonly networkFeeLamports: bigint;
  readonly priorityFeeLamports: bigint;
  readonly tipLamports: bigint;
  /** Erwartete Gebuehren fuer Versuche, die fehlschlagen, bevor einer durchgeht. */
  readonly expectedFailureLamports: bigint;
  readonly chainCosts: Money;
  readonly dexFee: Money;
  readonly priceImpact: Money;
  readonly latencyDrift: Money;
  readonly total: Money;
  /** Gesamtkosten relativ zum Volumen — die Groesse, die den Edge auffrisst. */
  readonly totalBps: Bps;
}

export const DEFAULT_FEES: FeeAssumptions = {
  signatureCount: 1,
  computeUnitLimit: 200_000,
  computeUnitPriceMicroLamports: 50_000,
  tipLamports: 0n,
  failureRate: 0.1,
};

export const DEFAULT_LATENCY: LatencyAssumptions = {
  quoteToFillMs: 2_000,
  adverseDriftBpsPerSecond: 25,
};

function lamportsToMoney(lamports: bigint, solPrice: Money): Money {
  // 1 SOL = 1e9 Lamports; solPrice.minor ist der Preis in kleinster Fiat-Einheit.
  return money(mulDiv(lamports, solPrice.minor, 1_000_000_000n, "ceil"), solPrice.currency);
}

export function estimateExecutionCosts(input: CostModelInputs): ExecutionCostEstimate {
  const currency: Currency = input.notional.currency;
  if (input.solPrice.currency !== currency) {
    throw new TypeError(
      `SOL-Preis in ${input.solPrice.currency}, Volumen in ${currency} — nicht verrechenbar`,
    );
  }
  if (input.fees.failureRate < 0 || input.fees.failureRate >= 1) {
    throw new RangeError(`failureRate muss in [0,1) liegen, war ${input.fees.failureRate}`);
  }

  const networkFeeLamports = LAMPORTS_PER_SIGNATURE * BigInt(input.fees.signatureCount);

  // Priority Fee = ComputeUnits * Preis-je-CU. Der Preis ist in Micro-Lamports.
  const priorityFeeLamports = mulDiv(
    BigInt(input.fees.computeUnitLimit),
    BigInt(input.fees.computeUnitPriceMicroLamports),
    1_000_000n,
    "ceil",
  );

  const perAttemptLamports = networkFeeLamports + priorityFeeLamports + input.fees.tipLamports;

  // Erwartete Zahl fehlgeschlagener Versuche vor einem erfolgreichen: p / (1 - p).
  const failureNumerator = BigInt(Math.round(input.fees.failureRate * 1_000_000));
  const failureDenominator = BigInt(Math.round((1 - input.fees.failureRate) * 1_000_000));
  const expectedFailureLamports =
    failureDenominator === 0n
      ? 0n
      : mulDiv(perAttemptLamports, failureNumerator, failureDenominator, "ceil");

  const chainCosts = lamportsToMoney(perAttemptLamports + expectedFailureLamports, input.solPrice);

  const dexFee = money(applyBps(input.notional.minor, input.dexFeeBps, "ceil"), currency);
  const priceImpact = money(applyBps(input.notional.minor, input.priceImpactBps, "ceil"), currency);

  const driftBps = bps(
    Math.ceil((input.latency.quoteToFillMs / 1_000) * input.latency.adverseDriftBpsPerSecond),
  );
  const latencyDrift = money(applyBps(input.notional.minor, driftBps, "ceil"), currency);

  const totalMinor =
    chainCosts.minor + dexFee.minor + priceImpact.minor + latencyDrift.minor;
  const total = money(totalMinor, currency);

  const totalBps =
    input.notional.minor === 0n
      ? bps(0)
      : bps(Number(mulDiv(totalMinor, 10_000n, input.notional.minor, "ceil")));

  return {
    networkFeeLamports,
    priorityFeeLamports,
    tipLamports: input.fees.tipLamports,
    expectedFailureLamports,
    chainCosts,
    dexFee,
    priceImpact,
    latencyDrift,
    total,
    totalBps,
  };
}

/**
 * Variante fuer Inputs, die aus Provider-Beobachtungen stammen.
 *
 * Fehlt ein Input, gibt es kein Ergebnis — und ausdruecklich keinen geschaetzten
 * Ersatzwert. Ohne belastbare Kostenschaetzung darf nicht gehandelt werden.
 */
export function estimateExecutionCostsFromObservations(input: {
  readonly notional: Money;
  readonly dexFeeBps: Maybe<Bps>;
  readonly priceImpactBps: Maybe<Bps>;
  readonly solPrice: Maybe<Money>;
  readonly fees: FeeAssumptions;
  readonly latency: LatencyAssumptions;
}): Result<ExecutionCostEstimate, MissingReason> {
  const required: ReadonlyArray<Maybe<unknown>> = [
    input.dexFeeBps,
    input.priceImpactBps,
    input.solPrice,
  ];
  const firstMissing = required.find((m): m is Missing => !isPresent(m));
  if (firstMissing) return err(firstMissing.reason);

  return ok(
    estimateExecutionCosts({
      notional: input.notional,
      dexFeeBps: (input.dexFeeBps as { value: Bps }).value,
      priceImpactBps: (input.priceImpactBps as { value: Bps }).value,
      solPrice: (input.solPrice as { value: Money }).value,
      fees: input.fees,
      latency: input.latency,
    }),
  );
}

/** Aufschluesselung fuer Anzeige und Logs. Eine Summe allein ist nicht pruefbar. */
export function formatCostBreakdown(e: ExecutionCostEstimate): string {
  return [
    `DEX ${formatMoney(e.dexFee)}`,
    `Impact ${formatMoney(e.priceImpact)}`,
    `Drift ${formatMoney(e.latencyDrift)}`,
    `Chain ${formatMoney(e.chainCosts)}`,
  ].join(" · ");
}
