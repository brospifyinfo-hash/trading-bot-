import {
  DEFAULT_SYSTEM_STATE,
  bps,
  eur,
  strategyVersionId as asStrategyVersionId,
  type Clock,
  type Maybe,
} from "@sae/core";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { DEFAULT_FEES, DEFAULT_LATENCY } from "@sae/simulation";
import { PaperExecutor, type ExecutionPlan, type QuoteSource } from "@sae/trading";
import { summarizeFleet } from "@sae/providers";
import { schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";

import type { PipelineDeps } from "../opportunity-pipeline";

/**
 * Aufbau fuer die Pipeline-Tests.
 *
 * Die Quote-Quelle ist ein TEST FIXTURE, kein nachgebauter Anbieter: sie
 * beantwortet genau eine Frage — „wie viele Token bekomme ich fuer 100 €" —
 * mit einem festen Wert, damit die Ausfuehrung ein bestimmtes Ergebnis hat.
 * Sie behauptet keinen Marktpreis und wird nirgends als Datenquelle gefuehrt.
 */
export class FixtureQuoteSource implements QuoteSource {
  constructor(
    private readonly outAmount: bigint,
    private readonly priceImpactBps = 45,
  ) {}

  async quote(
    plan: ExecutionPlan,
  ): Promise<Maybe<{ outAmount: bigint; priceImpactBps: ReturnType<typeof bps> }>> {
    void plan;
    return {
      kind: "OBSERVED",
      value: { outAmount: this.outAmount, priceImpactBps: bps(this.priceImpactBps) },
      source: "TEST_FIXTURE" as never,
      observedAt: new Date(0),
      sourceTs: null,
      confidence: 1,
    };
  }
}

/** Quote-Quelle, die nichts liefert — fuer den Ausfallpfad. */
export class NoQuoteSource implements QuoteSource {
  async quote(): Promise<Maybe<{ outAmount: bigint; priceImpactBps: ReturnType<typeof bps> }>> {
    return { kind: "MISSING", reason: "PROVIDER_DOWN", source: null, observedAt: new Date(0) };
  }
}

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(at: Date): void {
    this.current = at;
  }
}

export interface Harness {
  readonly db: Database;
  readonly close: () => Promise<void>;
  readonly tokenId: string;
  readonly strategyVersionId: string;
  readonly clock: FixedClock;
  deps(overrides?: Partial<PipelineDeps>): PipelineDeps;
}

const MINT = "So11111111111111111111111111111111111111112";

export async function createHarness(at: Date): Promise<Harness> {
  const { db, close } = await createTestDatabase();

  const [token] = await db
    .insert(schema.tokens)
    .values({ mint: MINT, decimals: 9, discoverySource: "test" })
    .returning();
  const [strategy] = await db.insert(schema.strategies).values({ name: "pipeline" }).returning();
  const [version] = await db
    .insert(schema.strategyVersions)
    .values({
      strategyId: strategy!.id,
      version: "1.0.0",
      parameters: {},
      reason: "Testfixture fuer die Pipeline",
    })
    .returning();

  const clock = new FixedClock(at);

  // Ohne erreichbaren Anbieter — der ehrliche Zustand. Der Fixture-Pfad
  // ueberschreibt die Bereitschaft eng begrenzt, faerbt aber keinen Anbieter.
  const fleet = summarizeFleet([]);

  return {
    db,
    close,
    tokenId: token!.id,
    strategyVersionId: version!.id,
    clock,
    deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
      const executor = new PaperExecutor({
        clock,
        quotes: new FixtureQuoteSource(1_000_000n),
        fees: DEFAULT_FEES,
        latency: DEFAULT_LATENCY,
        solPrice: eur(150),
        dexFeeBps: bps(25),
        // Deterministisch: kein Fehlschlag, keine Drift. Der Zufall gehoert in
        // eigene Tests, nicht in den Nachweis, dass die Kette laeuft.
        random: () => 1,
        driftSample: () => 0,
      });

      return {
        db,
        clock,
        strategyVersionId: asStrategyVersionId(version!.id),
        parameters: DEFAULT_STRATEGY_PARAMETERS,
        systemState: DEFAULT_SYSTEM_STATE,
        fleet,
        snapshotCount: 0,
        minSnapshotsForAnalysis: 100,
        executor,
        inputMint: MINT,
        outputMint: MINT,
        manualRespondMs: 300_000,
        decisionContext: {
          executionMode: "paper",
          decisionMode: "auto",
          liveTradingEnabled: false,
          criticalProvidersUnavailable: [],
          tokenBlacklisted: false,
          hasOpenIntentOnMint: false,
          breakers: { open: [], entriesBlocked: false, allTradingBlocked: false, reasons: [] },
          sizing: {
            size: eur(100),
            bindingConstraint: "RISK_BUDGET",
            candidates: {
              RISK_BUDGET: eur(100),
              LIQUIDITY: eur(100),
              PORTFOLIO_CAP: eur(100),
              CONFIDENCE: eur(100),
            },
            tradeable: true,
          },
          ev: {
            estimate: { kind: "UNKNOWN", reason: "INSUFFICIENT_SAMPLE", sampleSize: 0 },
            pointEv: null,
            conservativeEv: null,
            winRate: null,
            winRateLowerBound: null,
            avgWin: null,
            avgLoss: null,
          },
          exposureViolations: [],
        },
        ...overrides,
      };
    },
  };
}

export { MINT };
