import { z } from "zod";
import { HARD_LIMITS } from "./risk-limits";

const bpsSchema = z.number().int().nonnegative();
const scoreSchema = z.number().int().min(0).max(100);
const pctSchema = z.number().positive();

export const takeProfitLevelSchema = z.object({
  index: z.number().int().min(1),
  /** Auslöseschwelle als Gewinn in Basispunkten, z. B. 2500 = +25 %. */
  triggerGainBps: bpsSchema.min(1),
  /** Anteil der Ursprungsposition, der verkauft wird, in Basispunkten. */
  sellPortionBps: bpsSchema.min(1).max(10_000),
});

export const entryGatesSchema = z.object({
  minFinalScore: scoreSchema,
  minSecurityScore: scoreSchema,
  minLiquidityUsd: z.number().positive(),
  maxMarketCapUsd: z.number().positive(),
  minTokenAgeSeconds: z.number().int().nonnegative(),
  minSmartMoneyScore: scoreSchema,
  minSocialScore: scoreSchema,
  minMomentumScore: scoreSchema,
  maxTop10HolderSharePct: z.number().min(0).max(100),
  /** Anteil vorhandener Inputs, unter dem nicht gehandelt wird. */
  minDataCompleteness: z.number().min(0).max(1),
  /**
   * Ab wie vielen abgeschlossenen Trades im passenden Bucket eine EV-Schaetzung
   * als belastbar gilt. Darunter ist der Erwartungswert UNKNOWN — und UNKNOWN
   * heisst im Auto-Modus: kein Trade.
   */
  minEvSampleSize: z.number().int().min(1),
  minEvConfidence: z.number().min(0).max(1),
});

export const riskSchema = z.object({
  riskPerTradePct: pctSchema.max(HARD_LIMITS.maxRiskPerTradePct),
  maxPositionPct: pctSchema.max(HARD_LIMITS.maxPositionPctOfPortfolio),
  maxPortfolioExposurePct: pctSchema.max(HARD_LIMITS.maxPortfolioExposurePct),
  maxDailyLossPct: pctSchema.max(HARD_LIMITS.maxDailyLossPct),
  maxOpenPositions: z.number().int().min(1).max(HARD_LIMITS.maxOpenPositions),
  maxConsecutiveLosses: z.number().int().min(1),
  maxSlippageBps: bpsSchema.max(HARD_LIMITS.maxSlippageBps),
  maxPriceImpactBps: bpsSchema.max(HARD_LIMITS.maxPriceImpactBps),
  /** Anteil der Position, der zum modellierten Impact ausstiegsfaehig sein muss. */
  minExitCapacityRatio: z.number().min(1),
});

export const exitSchema = z
  .object({
    stopLossBps: bpsSchema.min(1).max(10_000),
    takeProfits: z.array(takeProfitLevelSchema).min(1),
    trailingStopBps: bpsSchema.min(1).max(10_000).nullable(),
    /** Adaptive Exit-Regeln, einzeln schaltbar, damit sie einzeln messbar sind. */
    dynamicExitRules: z.array(z.string()).default([]),
    maxHoldingTimeSeconds: z.number().int().positive().nullable(),
  })
  .superRefine((value, ctx) => {
    const totalSell = value.takeProfits.reduce((sum, tp) => sum + tp.sellPortionBps, 0);
    if (totalSell > 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["takeProfits"],
        message: `Take-Profit-Stufen verkaufen zusammen ${totalSell} bp — mehr als die Position hergibt (10000 bp).`,
      });
    }
    const indices = value.takeProfits.map((tp) => tp.index);
    if (new Set(indices).size !== indices.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["takeProfits"],
        message: "Take-Profit-Stufen haben doppelte Indizes.",
      });
    }
    const sorted = [...value.takeProfits].sort((a, b) => a.index - b.index);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.triggerGainBps <= sorted[i - 1]!.triggerGainBps) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["takeProfits"],
          message: `Stufe ${sorted[i]!.index} loest nicht spaeter aus als Stufe ${sorted[i - 1]!.index}.`,
        });
        break;
      }
    }
    if (totalSell === 10_000 && value.trailingStopBps !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trailingStopBps"],
        message:
          "Trailing Stop konfiguriert, aber die Take-Profit-Stufen verkaufen bereits 100 % — es bliebe kein Runner uebrig.",
      });
    }
  });

export const strategyParametersSchema = z.object({
  entryGates: entryGatesSchema,
  risk: riskSchema,
  exit: exitSchema,
  /** Snapshot-Takt fuer beobachtete, aber nicht gehandelte Tokens. */
  watchlistRescoreIntervalSeconds: z.number().int().min(10),
  /** Cooldown zwischen zwei Alerts zum selben Token. */
  alertCooldownSeconds: z.number().int().min(0),
  /** Score-Sprung, der einen erneuten Alert trotz Cooldown rechtfertigt. */
  alertScoreJumpThreshold: z.number().int().min(1),
});

export type StrategyParameters = z.infer<typeof strategyParametersSchema>;
export type TakeProfitLevelConfig = z.infer<typeof takeProfitLevelSchema>;

export const strategyVersionSchema = z.object({
  strategyId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version muss der Form 1.0.0 folgen"),
  parameters: strategyParametersSchema,
  /** Warum diese Version existiert. Pflichtfeld — eine Aenderung ohne Begruendung
   *  ist im Nachhinein nicht auswertbar. */
  reason: z.string().min(10),
  createdAt: z.date(),
});

export type StrategyVersion = z.infer<typeof strategyVersionSchema>;

export function parseStrategyParameters(input: unknown): StrategyParameters {
  return strategyParametersSchema.parse(input);
}
