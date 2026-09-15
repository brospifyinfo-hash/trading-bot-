import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { MEMECOIN_PAPER_CANDIDATE, strategyParametersSchema } from "@sae/config";
import { schema, type Database } from "@sae/db";

export const PAPER_CANDIDATE_SELECTOR = "memecoin-risk-managed-v1";
export const usesPaperCandidate = (env: NodeJS.ProcessEnv): boolean => env["PAPER_STRATEGY"] === PAPER_CANDIDATE_SELECTOR;

/** Called only for an explicitly selected paper candidate; never overwrites a version. */
export async function ensurePaperCandidateVersion(db: Database, at: Date) {
  const candidate = MEMECOIN_PAPER_CANDIDATE;
  return db.transaction(async (tx) => {
    await tx.insert(schema.strategies).values({ name: candidate.strategyId }).onConflictDoNothing();
    const [strategy] = await tx.select().from(schema.strategies).where(eq(schema.strategies.name, candidate.strategyId)).for("update");
    if (strategy === undefined) throw new Error("Missing paper strategy");
    const inserted = await tx.insert(schema.strategyVersions).values({ strategyId: strategy.id,
      version: candidate.version, parameters: candidate.parameters, activatedAt: at,
      reason: "Explicit paper-only selection; unvalidated risk-managed candidate, no profitability claim.",
    }).onConflictDoNothing().returning({ id: schema.strategyVersions.id });
    const [version] = await tx.select().from(schema.strategyVersions).where(and(
      eq(schema.strategyVersions.strategyId, strategy.id), eq(schema.strategyVersions.version, candidate.version)));
    const parsed = strategyParametersSchema.safeParse(version?.parameters);
    if (version === undefined || version.retiredAt !== null || !parsed.success || !isDeepStrictEqual(parsed.data, candidate.parameters)) {
      throw new Error("Stored candidate version differs or is retired; create a new version instead");
    }
    return { id: version.id, version: version.version, created: inserted.length > 0 };
  });
}
