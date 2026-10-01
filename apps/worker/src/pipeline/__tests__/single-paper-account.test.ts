import { expect, it } from "vitest";
import { eur, strategyVersionId } from "@sae/core";
import { MEMECOIN_PAPER_CANDIDATE, PAPER_STRATEGY_ID, paperCandidate } from "@sae/config";
import { schema, OpportunityRepository, PaperPositionRepository, loadPaperTrading } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { ensurePaperCandidateVersion } from "../paper-candidate-version";

/**
 * Ein Konto, eine frei waehlbare Schwelle — und was dabei NICHT passieren darf.
 *
 * Vorher liefen drei Profile mit drei getrennten Buchfuehrungen nebeneinander.
 * Jetzt gibt es ein Konto, und die Einstiegsschwelle ist einstellbar. Die
 * gefaehrliche Stelle an dieser Umstellung ist nicht die Schwelle selbst,
 * sondern ihre Beziehung zur Buchfuehrung:
 *
 * - Die Schwelle MUSS eine neue, unveraenderliche Strategie-Version erzeugen.
 *   Sonst waere jede frueher getroffene Entscheidung rueckwirkend an einer
 *   Regel gemessen, die zu ihrer Zeit nicht galt.
 * - Das Konto DARF dabei nicht wechseln. Sonst haette ein Dreh am Regler einen
 *   neuen Barbestand zur Folge, und die offenen Positionen des alten Kontos
 *   stuenden ohne Aufsicht da.
 *
 * Beides zusammen geht nur, weil die Kontofuehrung an der Strategie-FAMILIE
 * haengt und nicht an der Version.
 */
it("behaelt ein Konto ueber eine Schwellenaenderung hinweg, mit eigener Version je Schwelle", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-10-01T12:00:00Z");

    // Die Standard-Parameter bleiben die Grundlage, aus der der Kandidat
    // entsteht. Sie stehen hier, damit eine stille Aenderung an ihnen auffaellt.
    expect(MEMECOIN_PAPER_CANDIDATE.version).toBe("1.0.0");
    expect(MEMECOIN_PAPER_CANDIDATE.parameters.entryGates).toMatchObject({
      minFinalScore: 75, minMomentumScore: 60, maxMarketCapUsd: 5_000_000,
    });

    const bei35 = await ensurePaperCandidateVersion(db, at, paperCandidate(35));
    const bei70 = await ensurePaperCandidateVersion(db, at, paperCandidate(70));
    expect(bei35.id).not.toBe(bei70.id);

    // Beide Versionen gehoeren derselben Familie — und damit demselben Konto.
    const familien = await db
      .select({ name: schema.strategies.name })
      .from(schema.strategies);
    expect(familien.map((f) => f.name)).toEqual([PAPER_STRATEGY_ID]);

    const [token] = await db
      .insert(schema.tokens)
      .values({ mint: "single-paper-test", discoverySource: "test" })
      .returning();
    const repo = new OpportunityRepository(db);
    const positions = new PaperPositionRepository(db);

    const gelegenheit = async (version: string) =>
      repo.create({
        tokenId: token!.id, strategyVersionId: version, stream: "AUTO_PAPER" as const,
        provenance: {
          sourceType: "LIVE" as const, sourceProvider: "test", sourceTier: "PRIMARY" as const,
          sourceTimestamp: at, dataTimestamp: at, decisionTimestamp: at, dataQuality: 1,
        },
        decisionKind: "ENTER" as const, finalScore: 85, reasons: [], risks: [], rejectionReasons: [],
        decidedAt: at, respondBy: null,
        snapshot: {
          tokenId: token!.id, observedAt: at, features: {}, missingFields: [], dataCompleteness: 1,
          scoreEngineVersion: "1", featureSetVersion: "1", inputHash: `hash-${version}`,
        },
      });

    const ersteGelegenheit = await gelegenheit(bei35.id);
    expect(ersteGelegenheit.kind).toBe("CREATED");
    if (ersteGelegenheit.kind !== "CREATED") throw new Error("Gelegenheit fehlt");

    const offen = await positions.open({
      opportunityId: ersteGelegenheit.opportunityId, tokenId: token!.id,
      strategyVersionId: bei35.id, stream: "AUTO_PAPER", sizingMode: "RISK_BASED",
      entryNotional: eur(100), entryAmountRaw: 100n, entryCostsMinor: 100n,
      openedAt: at, fromState: "OFFERED", sourceType: "LIVE",
    });
    if (offen.kind !== "OPENED") throw new Error("Position fehlt");

    const nachEinstieg = await loadPaperTrading({ db, strategyName: PAPER_STRATEGY_ID, now: at });
    expect(nachEinstieg.kind).toBe("READY");
    if (nachEinstieg.kind !== "READY") throw new Error("Konto fehlt");
    expect(nachEinstieg.account.cash).toEqual(eur(2899));
    expect(nachEinstieg.open).toHaveLength(1);

    // Der Kern: eine Position, die unter Schwelle 35 eroeffnet wurde, bleibt
    // nach dem Wechsel auf 70 dieselbe Position im selben Konto. Der Regler
    // aendert, wonach NEU entschieden wird — nicht, was schon laeuft.
    const nachWechsel = await loadPaperTrading({ db, strategyName: PAPER_STRATEGY_ID, now: at });
    expect(nachWechsel).toEqual(nachEinstieg);

    await positions.settleSale({
      positionId: offen.positionId, expectedVersion: 0, soldAmountRaw: 100n,
      proceeds: eur(120), costs: eur(1), at, reason: "TAKE_PROFIT", levelIndex: null,
      maxAdverseExcursion: 0, maxFavorableExcursion: 0.2, valuation: { source: "TEST_FIXTURE" },
    });

    const nachVerkauf = await loadPaperTrading({ db, strategyName: PAPER_STRATEGY_ID, now: at });
    if (nachVerkauf.kind !== "READY") throw new Error("Konto fehlt");
    expect(nachVerkauf.account.cash).toEqual(eur(3018));
    expect(nachVerkauf.closedCount).toBe(1);
    expect(nachVerkauf.open).toHaveLength(0);
  } finally { await close(); }
}, 30_000);

it("haelt Entscheidungen auseinander, die unter verschiedenen Schwellen fielen", async () => {
  const { createHarness } = await import("./harness");
  const { testFixtureRequest } = await import("../test-fixture");
  const { runOpportunityPipeline } = await import("../opportunity-pipeline");
  const at = new Date("2026-10-01T12:00:00Z");
  const h = await createHarness(at);
  try {
    const request = testFixtureRequest({ tokenId: h.tokenId, asOf: at, label: "single-account" });
    for (const score of [35, 70]) {
      const kandidat = paperCandidate(score);
      const version = await ensurePaperCandidateVersion(h.db, at, kandidat);
      const deps = h.deps({
        strategyVersionId: strategyVersionId(version.id),
        parameters: kandidat.parameters,
      });
      // Zweimal derselbe Lauf: die zweite Entscheidung darf keine zweite Zeile
      // erzeugen, sonst zaehlte jeder Takt als neue Entscheidung.
      await runOpportunityPipeline(request, { ...deps, decisionContext: { ...deps.decisionContext, tokenBlacklisted: true } });
      await runOpportunityPipeline(request, { ...deps, decisionContext: { ...deps.decisionContext, tokenBlacklisted: true } });
    }
    const decisions = await h.db.select().from(schema.decisions);
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((d) => d.strategyVersionId)).size).toBe(2);
    expect(decisions.every((d) => d.branchCount === 2)).toBe(true);
  } finally { await h.close(); }
}, 30_000);
