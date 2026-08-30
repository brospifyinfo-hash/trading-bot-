import { money, mulDiv, type Currency, type Money } from "@sae/core";

/**
 * Gewinn- und Verlustrechnung.
 *
 * EINE Implementierung fuer Paper und Live. Getrennte Rechenwege waeren die
 * bequemste Art, sich selbst zu betruegen: die Paper-Statistik saehe dann besser
 * aus als die Realitaet, ohne dass es jemandem auffiele.
 *
 * Kostenbasis wird anteilig ueber die Gesamtposition ermittelt, nicht ueber einen
 * gerundeten Stueckpreis — sonst summieren sich Rundungsfehler ueber viele
 * Teilverkaeufe zu einem sichtbaren Betrag.
 */

export interface TradeLeg {
  readonly side: "buy" | "sell";
  /** Token-Menge in kleinster Einheit. */
  readonly amountRaw: bigint;
  /** Bewegter Gegenwert in Portfoliowaehrung, brutto vor Kosten. */
  readonly notional: Money;
  /** Ausfuehrungskosten dieses Teils. */
  readonly costs: Money;
  readonly at: Date;
}

export interface PnlResult {
  readonly boughtRaw: bigint;
  readonly soldRaw: bigint;
  readonly remainingRaw: bigint;
  /** Eingesetztes Kapital brutto. */
  readonly investedNotional: Money;
  /** Erloes aus Verkaeufen brutto. */
  readonly proceedsNotional: Money;
  /** Kostenbasis des bereits verkauften Anteils. */
  readonly costBasisOfSold: Money;
  /** Erloes minus Kostenbasis, vor Ausfuehrungskosten. */
  readonly grossRealized: Money;
  readonly costsPaid: Money;
  /** Der Wert, der zaehlt: realisiert nach allen Kosten. */
  readonly netRealized: Money;
  /** Nur, wenn ein aktueller Wert der Restposition bekannt ist. */
  readonly unrealized: Money | null;
  readonly netTotal: Money | null;
  readonly isClosed: boolean;
}

export function computePnl(
  legs: readonly TradeLeg[],
  options: {
    readonly currency: Currency;
    /** Aktueller Marktwert der Restposition, brutto. `null`, wenn unbekannt. */
    readonly currentValueOfRemaining: Money | null;
  },
): PnlResult {
  const { currency } = options;
  const zero = money(0n, currency);

  let boughtRaw = 0n;
  let soldRaw = 0n;
  let investedMinor = 0n;
  let proceedsMinor = 0n;
  let costsMinor = 0n;

  for (const leg of legs) {
    if (leg.notional.currency !== currency || leg.costs.currency !== currency) {
      throw new TypeError(`Leg-Waehrung passt nicht zur Portfoliowaehrung ${currency}`);
    }
    if (leg.amountRaw < 0n) throw new RangeError("Leg-Menge darf nicht negativ sein");

    costsMinor += leg.costs.minor;
    if (leg.side === "buy") {
      boughtRaw += leg.amountRaw;
      investedMinor += leg.notional.minor;
    } else {
      soldRaw += leg.amountRaw;
      proceedsMinor += leg.notional.minor;
    }
  }

  if (soldRaw > boughtRaw) {
    throw new RangeError(
      `Mehr verkauft (${soldRaw}) als gekauft (${boughtRaw}) — die Ereigniskette ist inkonsistent`,
    );
  }

  const remainingRaw = boughtRaw - soldRaw;

  // Anteilige Kostenbasis: investiert * verkauft / gekauft.
  const costBasisOfSoldMinor =
    boughtRaw === 0n ? 0n : mulDiv(investedMinor, soldRaw, boughtRaw, "half-up");

  const grossRealizedMinor = proceedsMinor - costBasisOfSoldMinor;
  const netRealizedMinor = grossRealizedMinor - costsMinor;

  const isClosed = boughtRaw > 0n && remainingRaw === 0n;

  let unrealized: Money | null = null;
  let netTotal: Money | null = null;

  if (options.currentValueOfRemaining !== null) {
    if (options.currentValueOfRemaining.currency !== currency) {
      throw new TypeError("Waehrung des Restwerts passt nicht zur Portfoliowaehrung");
    }
    const remainingBasisMinor = investedMinor - costBasisOfSoldMinor;
    unrealized = money(options.currentValueOfRemaining.minor - remainingBasisMinor, currency);
    netTotal = money(netRealizedMinor + unrealized.minor, currency);
  } else if (isClosed) {
    // Geschlossene Position: es gibt nichts Unrealisiertes mehr.
    unrealized = zero;
    netTotal = money(netRealizedMinor, currency);
  }

  return {
    boughtRaw,
    soldRaw,
    remainingRaw,
    investedNotional: money(investedMinor, currency),
    proceedsNotional: money(proceedsMinor, currency),
    costBasisOfSold: money(costBasisOfSoldMinor, currency),
    grossRealized: money(grossRealizedMinor, currency),
    costsPaid: money(costsMinor, currency),
    netRealized: money(netRealizedMinor, currency),
    unrealized,
    netTotal,
    isClosed,
  };
}
