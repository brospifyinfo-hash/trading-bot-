import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { MEMECOIN_PAPER_CANDIDATE, strategyParametersSchema, type StrategyParameters } from "@sae/config";
import { schema, type Database } from "@sae/db";

export const PAPER_CANDIDATE_SELECTOR = "memecoin-risk-managed-v1";
export const usesPaperCandidate = (env: NodeJS.ProcessEnv): boolean => env["PAPER_STRATEGY"] === PAPER_CANDIDATE_SELECTOR;

/** Called only for an explicitly selected paper candidate; never overwrites a version. */
export async function ensurePaperCandidateVersion(db: Database, at: Date, candidate: { strategyId: string; version: string; parameters: StrategyParameters } = MEMECOIN_PAPER_CANDIDATE) {
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
    // Die drei Gruende werden GETRENNT genannt, und bei abweichenden
    // Parametern stehen die Feldnamen dabei.
    //
    // Vorher war es ein Satz fuer alle drei Faelle: „Stored candidate version
    // differs or is retired". Damit starben 4.657 `PAPER_SNIPER`-Auftraege,
    // jeder mit genau diesem Satz, und niemand konnte daraus ablesen, WELCHES
    // Feld abwich — also auch nicht, dass es `maxMarketCapUsd` war, das im
    // Versionsnamen fehlte. Ein Fehler, der seine Ursache nicht nennt, kostet
    // nicht einen Auftrag, sondern Wochen.
    if (version === undefined) {
      throw new Error(`Paper candidate version ${candidate.version} vanished after insert`);
    }
    if (version.retiredAt !== null) {
      throw new Error(
        `Paper candidate version ${candidate.version} is retired (${version.retiredAt.toISOString()}); create a new version instead`,
      );
    }
    const parsed = strategyParametersSchema.safeParse(version.parameters);
    if (!parsed.success) {
      throw new Error(
        `Stored parameters of ${candidate.version} do not parse: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
    }
    if (!isDeepStrictEqual(parsed.data, candidate.parameters)) {
      throw new Error(
        `Stored candidate version ${candidate.version} has different parameters at: ${abweichendeFelder(parsed.data, candidate.parameters).join(", ")}. The version name must change when parameters change — see parameterFingerprint.`,
      );
    }
    return { id: version.id, version: version.version, created: inserted.length > 0 };
  });
}

/**
 * Welche Felder abweichen — als Pfade, ohne Werte.
 *
 * Ohne Werte, weil die Meldung in `job_queue.last_error` landet und von dort
 * ins Dashboard: Parameter sind keine Geheimnisse, aber eine Fehlermeldung ist
 * der falsche Ort, um Zahlen auszuschuetten. Der Feldname genuegt, um die
 * Ursache zu finden.
 */
function abweichendeFelder(a: unknown, b: unknown, pfad = ""): readonly string[] {
  if (isDeepStrictEqual(a, b)) return [];
  const beide = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!beide(a) || !beide(b)) return [pfad === "" ? "(Wurzel)" : pfad];
  const schluessel = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: string[] = [];
  for (const k of schluessel) {
    out.push(...abweichendeFelder(a[k], b[k], pfad === "" ? k : `${pfad}.${k}`));
  }
  return out.length === 0 ? [pfad === "" ? "(Wurzel)" : pfad] : out;
}
