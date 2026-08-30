/**
 * Betraege.
 *
 * Grundregel: kein `number` fuer Geld. IEEE-754-Doubles koennen 0.1 + 0.2 nicht
 * exakt darstellen; bei Lamports (1 SOL = 1e9) und Token mit bis zu 18 Dezimal-
 * stellen ueberschreitet man ausserdem schnell die 53 Bit sichere Ganzzahl-Praezision.
 * Alle Betraege sind deshalb `bigint` in kleinster Einheit.
 *
 * Prozentwerte und Verhaeltnisse laufen als Basispunkte (1 bp = 0,01 %) — ebenfalls
 * ganzzahlig, damit Gebuehren- und Slippage-Rechnung reproduzierbar bleibt.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Lamports = Brand<bigint, "Lamports">;
export type Bps = Brand<number, "Bps">;

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS_DENOMINATOR = 10_000;

export function lamports(value: bigint | number): Lamports {
  const v = typeof value === "number" ? BigInt(Math.trunc(value)) : value;
  if (v < 0n) throw new RangeError(`Lamports duerfen nicht negativ sein: ${v}`);
  return v as Lamports;
}

export function bps(value: number): Bps {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Basispunkte muessen ganzzahlig sein, waren ${value}`);
  }
  return value as Bps;
}

export const pctToBps = (percent: number): Bps => bps(Math.round(percent * 100));
export const bpsToPct = (v: Bps): number => v / 100;

/** Betrag eines SPL-Tokens in seiner kleinsten Einheit plus Dezimalstellen. */
export interface TokenAmount {
  readonly raw: bigint;
  readonly decimals: number;
}

export function tokenAmount(raw: bigint, decimals: number): TokenAmount {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`Ungueltige Dezimalstellen: ${decimals}`);
  }
  return { raw, decimals };
}

export type Currency = "EUR" | "USD";

/** Fiat-Betrag in kleinster Einheit (Cent). */
export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export function money(minor: bigint, currency: Currency): Money {
  return { minor, currency };
}

export const eur = (majorUnits: number): Money =>
  money(BigInt(Math.round(majorUnits * 100)), "EUR");
export const usd = (majorUnits: number): Money =>
  money(BigInt(Math.round(majorUnits * 100)), "USD");

export type Rounding = "floor" | "ceil" | "half-up";

/**
 * (value * numerator) / denominator mit explizitem Rundungsmodus.
 *
 * Der Rundungsmodus ist Pflicht, weil er bei Gebuehren und Mindestausgabemengen
 * die Richtung der Abweichung bestimmt: Kosten werden aufgerundet, garantierte
 * Ausgabemengen abgerundet. Ein impliziter Default wuerde das verschleiern.
 */
export function mulDiv(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding,
): bigint {
  if (denominator === 0n) throw new RangeError("Division durch Null");
  const negative = value < 0n !== numerator < 0n;
  const abs = (x: bigint): bigint => (x < 0n ? -x : x);
  const product = abs(value) * abs(numerator);
  const d = abs(denominator);

  let q = product / d;
  const remainder = product % d;

  if (remainder !== 0n) {
    if (rounding === "ceil" && !negative) q += 1n;
    else if (rounding === "floor" && negative) q += 1n;
    else if (rounding === "half-up" && remainder * 2n >= d) q += 1n;
  }
  return negative ? -q : q;
}

/** Wendet Basispunkte an, z. B. `applyBps(amount, bps(30))` = 0,30 % von amount. */
export function applyBps(value: bigint, rate: Bps, rounding: Rounding = "half-up"): bigint {
  return mulDiv(value, BigInt(rate), BigInt(BPS_DENOMINATOR), rounding);
}

/** Zieht Basispunkte ab, z. B. Slippage-Toleranz auf eine Mindestausgabemenge. */
export function subtractBps(value: bigint, rate: Bps): bigint {
  // Abrunden: die garantierte Mindestmenge darf nie zu hoch angesetzt werden.
  return mulDiv(value, BigInt(BPS_DENOMINATOR - rate), BigInt(BPS_DENOMINATOR), "floor");
}

/** Relative Abweichung von `from` nach `to` in Basispunkten. */
export function differenceBps(from: bigint, to: bigint): Bps {
  if (from === 0n) throw new RangeError("Relative Abweichung von 0 ist undefiniert");
  const diff = to - from;
  return bps(Number(mulDiv(diff, BigInt(BPS_DENOMINATOR), from, "half-up")));
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function sumMoney(values: readonly Money[], currency: Currency): Money {
  return values.reduce((acc, v) => addMoney(acc, v), money(0n, currency));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Waehrungen nicht mischbar: ${a.currency} und ${b.currency}`);
  }
}

/** Nur fuer Anzeige und Logs — nie als Rechengrundlage zurueckfuehren. */
export function formatMoney(m: Money): string {
  const negative = m.minor < 0n;
  const abs = negative ? -m.minor : m.minor;
  const major = abs / 100n;
  const minor = (abs % 100n).toString().padStart(2, "0");
  const symbol = m.currency === "EUR" ? "€" : "$";
  return `${negative ? "-" : ""}${symbol}${major}.${minor}`;
}

export function formatTokenAmount(a: TokenAmount): string {
  const divisor = 10n ** BigInt(a.decimals);
  const negative = a.raw < 0n;
  const abs = negative ? -a.raw : a.raw;
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(a.decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
