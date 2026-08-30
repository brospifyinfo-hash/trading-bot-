import { randomUUID } from "node:crypto";

/**
 * Korrelations-IDs ueber Queue-Grenzen hinweg.
 *
 * Ein Trade laeuft durch mehrere Prozesse: Discovery, Scoring, Decision,
 * Execution, Positions. Ohne durchgereichte ID laesst sich hinterher nicht
 * rekonstruieren, welche Beobachtung zu welchem Fill gefuehrt hat — und genau
 * das ist die Grundlage der Trade-Detail-Timeline.
 */

export interface TraceContext {
  readonly traceId: string;
  readonly decisionId?: string;
  readonly intentId?: string;
  readonly positionId?: string;
}

export const newTraceId = (): string => randomUUID();

export function childTrace(parent: TraceContext, extra: Partial<TraceContext>): TraceContext {
  return { ...parent, ...extra, traceId: parent.traceId };
}

/** Alle Felder sind auf der Log-Allowlist — sie sind ausdruecklich keine Geheimnisse. */
export function traceFields(ctx: TraceContext): Record<string, string> {
  const out: Record<string, string> = { traceId: ctx.traceId };
  if (ctx.decisionId) out["decisionId"] = ctx.decisionId;
  if (ctx.intentId) out["intentId"] = ctx.intentId;
  if (ctx.positionId) out["positionId"] = ctx.positionId;
  return out;
}
