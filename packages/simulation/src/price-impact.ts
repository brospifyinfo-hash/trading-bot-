import { bps, mulDiv, type Bps } from "@sae/core";

/**
 * Preis-Impact im Constant-Product-AMM (x * y = k).
 *
 * Wird gebraucht, wo kein echtes Router-Quote vorliegt — vor allem im Backtest.
 * Im Live- und Paper-Betrieb ist das echte Quote immer vorzuziehen, weil es die
 * tatsaechliche Route ueber mehrere Pools beruecksichtigt; diese Naeherung kennt
 * nur einen Pool und unterschaetzt deshalb systematisch, was ueber Splits ginge,
 * und ueberschaetzt, was ein einzelner flacher Pool hergibt.
 */

export interface PoolReserves {
  readonly reserveIn: bigint;
  readonly reserveOut: bigint;
  readonly feeBps: Bps;
}

export interface SwapEstimate {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  /** Anteil, der als Pool-Gebuehr abgeht. */
  readonly feeAmount: bigint;
  /** Verlust allein durch die Kurvenkruemmung, ohne Gebuehr. */
  readonly priceImpactBps: Bps;
}

/**
 * Ausgabemenge eines Swaps.
 *
 * Die Gebuehr wird vom Input abgezogen (Uniswap-V2-Konvention, der die gaengigen
 * Solana-AMMs folgen), danach greift die Kurve.
 */
export function estimateSwap(amountIn: bigint, pool: PoolReserves): SwapEstimate {
  if (amountIn < 0n) throw new RangeError("amountIn darf nicht negativ sein");
  if (pool.reserveIn <= 0n || pool.reserveOut <= 0n) {
    throw new RangeError("Pool-Reserven muessen positiv sein");
  }
  if (amountIn === 0n) {
    return { amountIn: 0n, amountOut: 0n, feeAmount: 0n, priceImpactBps: bps(0) };
  }

  const feeAmount = mulDiv(amountIn, BigInt(pool.feeBps), 10_000n, "ceil");
  const inAfterFee = amountIn - feeAmount;

  // Tatsaechliche Ausgabe entlang der Kurve.
  const amountOut = mulDiv(pool.reserveOut, inAfterFee, pool.reserveIn + inAfterFee, "floor");

  // Impact in geschlossener Form statt aus der Differenz zweier gerundeter Mengen.
  //
  //   idealOut = dx * y / x
  //   actualOut = y * dx / (x + dx)
  //   (idealOut - actualOut) / idealOut = dx / (x + dx)
  //
  // Der Umweg ueber die Mengen ist bei kleinen Ordergroessen unbrauchbar: dort
  // dominiert der Abrundungsfehler von amountOut das Ergebnis und meldet
  // zweistellige Basispunkte, wo real Bruchteile davon anliegen. Die Formel ist
  // ausserdem exakt invers zu maxAmountWithinImpact — beide muessen konsistent
  // bleiben, sonst widersprechen sich Exit-Gate und Kostenmodell.
  const impact = mulDiv(inAfterFee, 10_000n, pool.reserveIn + inAfterFee, "half-up");

  return { amountIn, amountOut, feeAmount, priceImpactBps: bps(Number(impact)) };
}

/**
 * Groesste Menge, die sich innerhalb einer Impact-Obergrenze verkaufen laesst.
 *
 * Aus impact = dx / (reserveIn + dx) folgt dx = reserveIn * p / (1 - p). Die
 * geschlossene Form spart eine Suche und ist im Backtest millionenfach billiger.
 */
export function maxAmountWithinImpact(reserveIn: bigint, maxImpactBps: Bps): bigint {
  if (maxImpactBps <= 0) return 0n;
  if (maxImpactBps >= 10_000) return reserveIn * 1_000_000n; // praktisch unbegrenzt
  return mulDiv(reserveIn, BigInt(maxImpactBps), BigInt(10_000 - maxImpactBps), "floor");
}
