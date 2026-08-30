import { z } from "zod";

/**
 * Antwortschema der Jupiter Swap API v1.
 *
 * Abgeleitet aus der Hersteller-eigenen OpenAPI-Spezifikation
 * (jup-ag/jupiter-quote-api-node, swagger.yaml, geprueft 2026-08-30) —
 * NICHT aus erinnerten Feldnamen. Siehe docs/providers/jupiter.md.
 *
 * Zwei Eigenheiten, die das Schema bewusst abbildet:
 *
 * - Betraege sind STRINGS. u64-Werte ueberschreiten die sichere Double-Praezision;
 *   wer sie als Zahl behandelt, verliert bei grossen Mengen stillschweigend
 *   Stellen. Sie werden erst beim Mappen zu `bigint`.
 *
 * - `priceImpactPct` ist ein String und ein Dezimalbruch ("0.0012" = 0,12 %),
 *   keine Basispunkte. Die Verwechslung waere ein Faktor 10000 im Kosten-Gate.
 */

/** u64 als Dezimalstring — genau das, was die Spezifikation vorsieht. */
const u64String = z
  .string()
  .regex(/^\d+$/, "erwartet eine vorzeichenlose Ganzzahl als String");

/** Dezimalbruch als String, z. B. "0.0012" oder "-0.0003". */
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/, "erwartet einen Dezimalwert als String");

export const swapInfoSchema = z.object({
  ammKey: z.string(),
  label: z.string().optional(),
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: u64String,
  outAmount: u64String,
});

export const routePlanStepSchema = z.object({
  swapInfo: swapInfoSchema,
  percent: z.number().int().nullable().optional(),
  bps: z.number().int().optional(),
});

export const quoteResponseSchema = z.object({
  inputMint: z.string(),
  inAmount: u64String,
  outputMint: z.string(),
  outAmount: u64String,
  /**
   * Mindestausgabemenge nach Slippage — laut Spezifikation ausdruecklich
   * NICHT der Wert, mit dem `/swap` die Transaktion baut. Die verbindliche
   * Untergrenze steht in der gebauten Transaktion.
   */
  otherAmountThreshold: u64String,
  swapMode: z.string(),
  slippageBps: z.number().int().min(0),
  priceImpactPct: decimalString,
  routePlan: z.array(routePlanStepSchema),
  platformFee: z
    .object({ amount: u64String.optional(), feeBps: z.number().int().optional() })
    .nullable()
    .optional(),
  contextSlot: z.number().int().optional(),
  timeTaken: z.number().optional(),
  instructionVersion: z.enum(["V1", "V2"]).nullable().optional(),
});

export type JupiterQuoteResponse = z.infer<typeof quoteResponseSchema>;

export const swapResponseSchema = z.object({
  swapTransaction: z.string(),
  lastValidBlockHeight: z.number().int(),
  prioritizationFeeLamports: z.number().int().optional(),
});

export type JupiterSwapResponse = z.infer<typeof swapResponseSchema>;
