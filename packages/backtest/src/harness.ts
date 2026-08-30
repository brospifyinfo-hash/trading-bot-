import {
  bps,
  decisionId as toDecisionId,
  eur,
  money,
  mulDiv,
  observed,
  providerId,
  strategyVersionId as toStrategyVersionId,
  type Clock,
  type Currency,
  type Money,
  type TokenId,
} from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import { computeScores } from "@sae/scoring";
import { computePositionSize, type PortfolioState } from "@sae/risk";
import { decide, estimateEv, type OutcomeSample } from "@sae/decision";
import {
  DEFAULT_FEES,
  DEFAULT_LATENCY,
  estimateExecutionCosts,
  type FeeAssumptions,
  type LatencyAssumptions,
} from "@sae/simulation";
import { PaperExecutor, evaluatePosition, type PositionState } from "@sae/trading";
import type { ClosedTrade } from "@sae/analytics";
import type { BacktestDataSource } from "./sources";
import { halfNormalDrift, mulberry32 } from "./rng";

/**
 * Backtest-Harness.
 *
 * Er laeuft die simulierte Zeit in festen Schritten ab und ruft die Datenquellen
 * AUSSCHLIESSLICH mit der jeweils aktuellen Simulationszeit auf. Dass er niemals
 * in die Zukunft greift, ist damit keine Frage der Sorgfalt, sondern eine
 * Eigenschaft der Schleife — und ein Test haelt sie fest.
 *
 * Er benutzt dieselbe Entscheidungs-, Risiko- und Positionslogik wie der
 * Livebetrieb und denselben `PaperExecutor`. Ein eigener, vereinfachter
 * Backtest-Pfad waere die verlaesslichste Art, sich ein Ergebnis zu erzeugen,
 * das im Betrieb nicht eintritt.
 */

export interface BacktestConfig {
  readonly from: Date;
  readonly to: Date;
  /** Abstand zweier Auswertungsschritte in Sekunden. */
  readonly stepSeconds: number;
  readonly parameters: StrategyParameters;
  readonly initialCapital: Money;
  readonly currency: Currency;
  readonly seed: number;
  readonly fees?: FeeAssumptions;
  readonly latency?: LatencyAssumptions;
  /** Skalierung der Drift-Ziehung. Annahme, bis kalibriert. */
  readonly driftScale?: number;
  readonly solPrice?: Money;
  /** Aktive Exit-Regeln. Leer heisst: keine dynamischen Regeln. */
  readonly enabledExitRuleIds?: readonly string[];
}

export interface BacktestResult {
  readonly trades: readonly ClosedTrade[];
  readonly rejections: ReadonlyMap<string, number>;
  readonly decisionsEvaluated: number;
  readonly entriesTaken: number;
  readonly stepsRun: number;
  /** Groesste `asOf`, mit der eine Datenquelle aufgerufen wurde. */
  readonly maxAsOfRequested: Date;
  readonly config: BacktestConfig;
}

interface OpenPosition {
  readonly tokenId: TokenId;
  readonly openedAt: Date;
  readonly entryPriceUsd: number;
  readonly entryLiquidityUsd: number;
  readonly notional: Money;
  readonly slippageBps: number;
  readonly state: PositionState;
  highWaterRatio: number;
  remainingBps: number;
  /** Ein- UND Ausstiegskosten. Waechst mit jedem Teilverkauf. */
  costsPaidMinor: bigint;
}

const SRC = providerId("backtest");

export async function runBacktest(
  source: BacktestDataSource,
  config: BacktestConfig,
): Promise<BacktestResult> {
  const currency = config.currency;
  const random = mulberry32(config.seed);
  const driftScale = config.driftScale ?? 0.004;

  let simNow = new Date(config.from.getTime());
  let maxAsOfRequested = new Date(config.from.getTime());
  const clock: Clock = { now: () => new Date(simNow.getTime()) };

  const trades: ClosedTrade[] = [];
  const rejections = new Map<string, number>();
  const open = new Map<TokenId, OpenPosition>();
  let portfolioValue = config.initialCapital;
  let decisionsEvaluated = 0;
  let entriesTaken = 0;
  let stepsRun = 0;
  let tradeCounter = 0;

  const executor = new PaperExecutor({
    clock,
    quotes: {
      quote: async (plan) => {
        // Die Quote-Anfrage laeuft ueber dieselbe Simulationszeit wie alles andere.
        const q = await source.quoteAt(plan.outputMint as unknown as TokenId, plan.notional.minor, simNow);
        if (q === null) {
          return { kind: "MISSING", reason: "NO_DATA_FOR_TOKEN", source: SRC, observedAt: simNow };
        }
        return observed(
          { outAmount: q.outAmount, priceImpactBps: bps(q.priceImpactBps) },
          SRC,
          simNow,
        );
      },
    },
    fees: config.fees ?? DEFAULT_FEES,
    latency: config.latency ?? DEFAULT_LATENCY,
    solPrice: config.solPrice ?? eur(150),
    dexFeeBps: bps(30),
    random,
    driftSample: () => halfNormalDrift(random, driftScale),
  });

  const trackAsOf = (at: Date): Date => {
    if (at > maxAsOfRequested) maxAsOfRequested = new Date(at.getTime());
    return at;
  };

  while (simNow <= config.to) {
    stepsRun += 1;

    // 1. Offene Positionen zuerst. Wer erst neue Einstiege sucht, verwaltet
    //    bestehende Positionen mit einem Schritt Verzoegerung — und genau in
    //    dieser Verzoegerung passieren die Verluste.
    for (const [tokenId, position] of [...open]) {
      const holdingSeconds = (simNow.getTime() - position.openedAt.getTime()) / 1_000;
      const market = await source.positionMarketAt(
        tokenId,
        position.entryPriceUsd,
        position.entryLiquidityUsd,
        position.highWaterRatio,
        holdingSeconds,
        trackAsOf(simNow),
      );
      if (market === null) continue;

      position.highWaterRatio = Math.max(position.highWaterRatio, market.priceRatio);

      const decision = evaluatePosition(
        { ...position.state, remainingBps: bps(position.remainingBps) },
        { ...market, highWaterRatio: position.highWaterRatio },
        config.enabledExitRuleIds === undefined
          ? {}
          : { enabledRuleIds: config.enabledExitRuleIds },
      );

      let closed = false;
      let realizedMinor = 0n;

      /**
       * Ein Verkauf kostet dasselbe wie ein Kauf: Gebuehr, Impact, Drift, Chain.
       * Kostenlose Ausstiege sind die stillste Art, einen Backtest zu
       * beschoenigen — sie fallen niemandem auf, weil in der Statistik ja
       * Kosten stehen. Nur eben nur die halben.
       */
      const sellPortion = (portionBps: number): void => {
        realizedMinor += pnlForPortion(position.notional, portionBps, market.priceRatio);
        const exitNotional = money(
          mulDiv(
            mulDiv(position.notional.minor, BigInt(portionBps), 10_000n, "floor"),
            BigInt(Math.round(market.priceRatio * 10_000)),
            10_000n,
            "floor",
          ),
          currency,
        );
        position.costsPaidMinor += estimateExecutionCosts({
          notional: exitNotional,
          dexFeeBps: bps(30),
          priceImpactBps: bps(Math.round((market.priceImpactBps ?? 70))),
          solPrice: config.solPrice ?? eur(150),
          fees: config.fees ?? DEFAULT_FEES,
          latency: config.latency ?? DEFAULT_LATENCY,
        }).total.minor;
      };

      for (const action of decision.actions) {
        if (action.kind === "EXIT_ALL") {
          sellPortion(position.remainingBps);
          position.remainingBps = 0;
          closed = true;
          break;
        }
        if (action.kind === "SELL_PORTION") {
          sellPortion(action.portionBps);
          position.remainingBps -= action.portionBps;
          if (position.remainingBps <= 0) closed = true;
        }
      }

      if (closed) {
        tradeCounter += 1;
        const netPnl = money(realizedMinor - position.costsPaidMinor, currency);
        trades.push({
          tradeId: `bt-${tradeCounter}`,
          tokenId,
          mode: "paper",
          openedAt: position.openedAt,
          closedAt: new Date(simNow.getTime()),
          investedNotional: position.notional,
          netPnl,
          costsPaid: money(position.costsPaidMinor, currency),
          realizedSlippageBps: position.slippageBps,
          strategyVersionId: "backtest",
          scoreEngineVersion: "1.0.0",
          exitReason: decision.signals[0]?.ruleId ?? decision.actions[0]?.kind ?? "UNKNOWN",
        });
        portfolioValue = money(portfolioValue.minor + netPnl.minor, currency);
        open.delete(tokenId);
      }
    }

    // 2. Neue Einstiege.
    const universe = await source.universeAt(trackAsOf(simNow));
    for (const tokenId of universe) {
      if (open.has(tokenId)) continue;

      const features = await source.featuresAt(tokenId, trackAsOf(simNow));
      if (features === null) continue;

      decisionsEvaluated += 1;
      const scoring = computeScores(features);

      // Erwartungswert aus den BISHER in diesem Lauf realisierten Trades — nicht
      // aus dem Gesamtergebnis. Alles andere waere Look-Ahead auf die eigene
      // Zukunft.
      const sample: OutcomeSample[] = trades.map((t) => ({
        netReturn:
          t.investedNotional.minor === 0n
            ? 0
            : Number(mulDiv(t.netPnl.minor, 10_000n, t.investedNotional.minor, "floor")) / 10_000,
      }));
      const ev = estimateEv({
        sample,
        expectedCostFraction: 0.02,
        minSampleSize: config.parameters.entryGates.minEvSampleSize,
      });

      const portfolio: PortfolioState = {
        value: portfolioValue,
        openPositions: [...open.values()].map((p) => ({
          tokenId: p.tokenId,
          notional: p.notional,
        })),
        realizedTodayPnl: money(0n, currency),
        consecutiveLosses: 0,
      };

      const sizing = computePositionSize({
        portfolioValue,
        stopDistance: config.parameters.exit.stopLossBps / 10_000,
        maxNotionalByLiquidity: money(portfolioValue.minor, currency),
        evConfidence: ev.estimate.kind === "ESTIMATED" ? ev.estimate.confidence : 0,
        minimumNotional: money(500n, currency),
        parameters: config.parameters,
      });

      const decision = decide({
        decisionId: toDecisionId(`bt-${stepsRun}-${tokenId}`),
        strategyVersionId: toStrategyVersionId("backtest"),
        features,
        scoring,
        parameters: config.parameters,
        criticalProvidersUnavailable: [],
        tokenBlacklisted: false,
        hasOpenIntentOnMint: false,
        executionMode: "paper",
        decisionMode: "auto",
        liveTradingEnabled: false,
        breakers: { open: [], entriesBlocked: false, allTradingBlocked: false, reasons: [] },
        sizing,
        ev,
        exposureViolations:
          portfolio.openPositions.length >= config.parameters.risk.maxOpenPositions
            ? ["MAX_OPEN_POSITIONS_REACHED"]
            : [],
      });

      for (const reason of decision.rejectionReasons) {
        rejections.set(reason, (rejections.get(reason) ?? 0) + 1);
      }
      if (decision.kind !== "ENTER") continue;

      const priceObs = features.market.priceUsd;
      const liquidityObs = features.market.liquidityUsd;
      if (priceObs.kind !== "OBSERVED" || liquidityObs.kind !== "OBSERVED") continue;

      const outcome = await executor.execute({
        intentId: `bt-${stepsRun}-${tokenId}`,
        side: "buy",
        inputMint: tokenId as unknown as never,
        outputMint: tokenId as unknown as never,
        inAmount: sizing.size.minor,
        notional: sizing.size,
        maxSlippageBps: bps(config.parameters.risk.maxSlippageBps),
        plannedAt: new Date(simNow.getTime()),
      });

      if (outcome.kind === "FAILED") {
        // Fehlgeschlagene Transaktionen kosten Gebuehren ohne Gegenwert. Sie
        // wegzulassen waere die haeufigste Beschoenigung im Backtest.
        portfolioValue = money(portfolioValue.minor - outcome.costs.total.minor, currency);
        continue;
      }
      if (outcome.kind !== "FILLED") continue;

      entriesTaken += 1;
      open.set(tokenId, {
        tokenId,
        openedAt: new Date(simNow.getTime()),
        entryPriceUsd: priceObs.value,
        entryLiquidityUsd: liquidityObs.value,
        notional: sizing.size,
        costsPaidMinor: outcome.costs.total.minor,
        slippageBps: outcome.realizedSlippageBps,
        highWaterRatio: 1,
        remainingBps: 10_000,
        state: {
          positionId: `bt-${stepsRun}-${tokenId}`,
          remainingBps: bps(10_000),
          stopLossBps: bps(config.parameters.exit.stopLossBps),
          trailingStopBps:
            config.parameters.exit.trailingStopBps === null
              ? null
              : bps(config.parameters.exit.trailingStopBps),
          takeProfits: config.parameters.exit.takeProfits.map((tp) => ({
            index: tp.index,
            triggerGainBps: bps(tp.triggerGainBps),
            sellPortionBps: bps(tp.sellPortionBps),
            hit: false,
          })),
          maxHoldingSeconds: config.parameters.exit.maxHoldingTimeSeconds,
        },
      });
    }

    simNow = new Date(simNow.getTime() + config.stepSeconds * 1_000);
  }

  return {
    trades,
    rejections,
    decisionsEvaluated,
    entriesTaken,
    stepsRun,
    maxAsOfRequested,
    config,
  };
}

/** Ergebnisbeitrag eines Teilverkaufs, brutto vor Kosten. */
function pnlForPortion(notional: Money, portionBps: number, priceRatio: number): bigint {
  const portionNotional = mulDiv(notional.minor, BigInt(portionBps), 10_000n, "floor");
  const value = mulDiv(portionNotional, BigInt(Math.round(priceRatio * 10_000)), 10_000n, "floor");
  return value - portionNotional;
}
