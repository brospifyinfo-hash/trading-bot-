import { money, type Currency, type Money } from "@sae/core";

/**
 * Kennzahlen abgeschlossener Trades.
 *
 * Zwei Regeln, die das Ergebnis von einer Werbebroschuere unterscheiden:
 *
 * 1. Kosten sind im Nettoergebnis enthalten. Eine Statistik, die Gebuehren,
 *    Slippage und Impact getrennt ausweist und dann trotzdem den Bruttogewinn
 *    als "Performance" zeigt, ist irrefuehrend.
 *
 * 2. Kein Trade wird ausgeschlossen. Weder Ausreisser noch "unrealistische"
 *    Faelle noch Fehlschlaege ohne Fill. Wer aus der Statistik entfernt, was
 *    nicht passt, misst am Ende seine eigene Auswahl.
 */

export interface ClosedTrade {
  readonly tradeId: string;
  readonly tokenId: string;
  readonly mode: "paper" | "live";
  readonly openedAt: Date;
  readonly closedAt: Date;
  /** Eingesetztes Kapital brutto. */
  readonly investedNotional: Money;
  /** Ergebnis NACH allen Kosten. Die einzige Zahl, die zaehlt. */
  readonly netPnl: Money;
  readonly costsPaid: Money;
  readonly realizedSlippageBps: number;
  readonly strategyVersionId: string;
  readonly scoreEngineVersion: string;
  readonly exitReason: string;
}

export interface TradeStatistics {
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly winRate: number | null;
  readonly averageWin: Money | null;
  readonly averageLoss: Money | null;
  readonly medianWin: Money | null;
  readonly medianLoss: Money | null;
  /** Summe der Gewinne geteilt durch Summe der Verluste. */
  readonly profitFactor: number | null;
  /** Erwartungswert je Trade, in Portfoliowaehrung. */
  readonly expectedValuePerTrade: Money | null;
  readonly totalNetPnl: Money;
  readonly totalCosts: Money;
  /** Groesster Rueckgang der kumulierten Ergebniskurve. */
  readonly maxDrawdown: Money;
  readonly averageHoldingSeconds: number | null;
  readonly bestTrade: Money | null;
  readonly worstTrade: Money | null;
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  readonly averageSlippageBps: number | null;
  /**
   * Ob die Stichprobe fuer eine Aussage ueberhaupt gross genug ist.
   * Bewusst Teil des Ergebnisses: eine Win Rate aus neun Trades ist Rauschen,
   * und die Zahl allein sieht nicht danach aus.
   */
  readonly sufficientSample: boolean;
}

/**
 * Ab wie vielen Trades eine Aussage ueberhaupt getragen wird.
 *
 * Faustregel: fuer eine Trefferquote auf plusminus 5 Prozentpunkte braucht es
 * mehrere hundert Beobachtungen. 100 ist die untere Grenze, ab der die Zahlen
 * nicht mehr reines Rauschen sind — nicht die Grenze, ab der sie belastbar sind.
 */
export const MIN_SAMPLE_FOR_VERDICT = 100;

export function computeTradeStatistics(
  trades: readonly ClosedTrade[],
  currency: Currency,
): TradeStatistics {
  const zero = money(0n, currency);

  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: null,
      averageWin: null,
      averageLoss: null,
      medianWin: null,
      medianLoss: null,
      profitFactor: null,
      expectedValuePerTrade: null,
      totalNetPnl: zero,
      totalCosts: zero,
      maxDrawdown: zero,
      averageHoldingSeconds: null,
      bestTrade: null,
      worstTrade: null,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      averageSlippageBps: null,
      sufficientSample: false,
    };
  }

  for (const trade of trades) {
    if (trade.netPnl.currency !== currency) {
      throw new TypeError(`Trade ${trade.tradeId} in anderer Waehrung als die Auswertung`);
    }
  }

  const ordered = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  const wins = ordered.filter((t) => t.netPnl.minor > 0n);
  const losses = ordered.filter((t) => t.netPnl.minor <= 0n);

  const sum = (list: readonly ClosedTrade[]): bigint =>
    list.reduce((acc, t) => acc + t.netPnl.minor, 0n);

  const totalNet = sum(ordered);
  const totalCosts = ordered.reduce((acc, t) => acc + t.costsPaid.minor, 0n);
  const grossWins = sum(wins);
  const grossLosses = -sum(losses);

  // Kumulierte Kurve und groesster Rueckgang von ihrem jeweiligen Hoch.
  let running = 0n;
  let peak = 0n;
  let maxDrawdown = 0n;
  for (const trade of ordered) {
    running += trade.netPnl.minor;
    if (running > peak) peak = running;
    const drawdown = peak - running;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  let currentWins = 0;
  let currentLosses = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const trade of ordered) {
    if (trade.netPnl.minor > 0n) {
      currentWins += 1;
      currentLosses = 0;
      if (currentWins > maxWins) maxWins = currentWins;
    } else {
      currentLosses += 1;
      currentWins = 0;
      if (currentLosses > maxLosses) maxLosses = currentLosses;
    }
  }

  const holdingSeconds = ordered.map(
    (t) => (t.closedAt.getTime() - t.openedAt.getTime()) / 1_000,
  );

  return {
    totalTrades: ordered.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: wins.length / ordered.length,
    averageWin: wins.length > 0 ? money(grossWins / BigInt(wins.length), currency) : null,
    averageLoss: losses.length > 0 ? money(grossLosses / BigInt(losses.length), currency) : null,
    medianWin: medianOf(wins, currency),
    medianLoss:
      losses.length > 0
        ? money(-(medianOf(losses, currency)?.minor ?? 0n), currency)
        : null,
    // Ohne Verluste ist der Profit Factor nicht definiert — und ausdruecklich
    // nicht "unendlich gut". Bei einer Stichprobe ohne einen einzigen Verlust
    // ist die Stichprobe das Problem, nicht die Strategie.
    profitFactor: grossLosses > 0n ? Number(grossWins) / Number(grossLosses) : null,
    expectedValuePerTrade: money(totalNet / BigInt(ordered.length), currency),
    totalNetPnl: money(totalNet, currency),
    totalCosts: money(totalCosts, currency),
    maxDrawdown: money(maxDrawdown, currency),
    averageHoldingSeconds:
      holdingSeconds.reduce((a, b) => a + b, 0) / holdingSeconds.length,
    bestTrade: money(
      ordered.reduce((best, t) => (t.netPnl.minor > best ? t.netPnl.minor : best), ordered[0]!.netPnl.minor),
      currency,
    ),
    worstTrade: money(
      ordered.reduce((worst, t) => (t.netPnl.minor < worst ? t.netPnl.minor : worst), ordered[0]!.netPnl.minor),
      currency,
    ),
    maxConsecutiveWins: maxWins,
    maxConsecutiveLosses: maxLosses,
    averageSlippageBps:
      ordered.reduce((a, t) => a + t.realizedSlippageBps, 0) / ordered.length,
    sufficientSample: ordered.length >= MIN_SAMPLE_FOR_VERDICT,
  };
}

function medianOf(trades: readonly ClosedTrade[], currency: Currency): Money | null {
  if (trades.length === 0) return null;
  const values = trades.map((t) => (t.netPnl.minor < 0n ? -t.netPnl.minor : t.netPnl.minor));
  values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return money(values[mid]!, currency);
  return money((values[mid - 1]! + values[mid]!) / 2n, currency);
}
