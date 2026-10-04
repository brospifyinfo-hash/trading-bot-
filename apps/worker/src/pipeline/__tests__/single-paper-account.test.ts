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

/**
 * Den Verkauf von Hand anfordern.
 *
 * Es wird dabei NICHT verkauft. Das Dashboard laeuft auf einer anderen
 * Maschine als der Worker, hat keinen Router-Zugang und muesste einen
 * Ausstiegskurs erfinden, um selbst zu schliessen — und ein erfundener
 * Ausstiegskurs macht die Papier-Statistik ab diesem Trade wertlos.
 *
 * Geprueft wird deshalb genau das: ein Vermerk entsteht, die Position bleibt
 * OFFEN, `version` bleibt unberuehrt, und der Eingriff steht in der Spur.
 */
it("vermerkt einen angeforderten Verkauf, ohne die Position zu schliessen", async () => {
  const { requestPositionClose, cancelPositionClose } = await import("@sae/db");
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-10-02T12:00:00Z");
    const version = await ensurePaperCandidateVersion(db, at, paperCandidate(10, "OFFENSIV"));
    const [token] = await db
      .insert(schema.tokens)
      .values({ mint: "manual-close-test", discoverySource: "test" })
      .returning();
    const repo = new OpportunityRepository(db);
    const gelegenheit = await repo.create({
      tokenId: token!.id, strategyVersionId: version.id, stream: "AUTO_PAPER" as const,
      provenance: { sourceType: "LIVE" as const, sourceProvider: "test",
        sourceTier: "PRIMARY" as const, sourceTimestamp: at, dataTimestamp: at,
        decisionTimestamp: at, dataQuality: 1 },
      decisionKind: "ENTER" as const, finalScore: 85, reasons: [], risks: [],
      rejectionReasons: [], decidedAt: at, respondBy: null,
      snapshot: { tokenId: token!.id, observedAt: at, features: {}, missingFields: [],
        dataCompleteness: 1, scoreEngineVersion: "1", featureSetVersion: "1",
        inputHash: "manual-close" },
    });
    if (gelegenheit.kind !== "CREATED") throw new Error("Gelegenheit fehlt");

    const offen = await new PaperPositionRepository(db).open({
      opportunityId: gelegenheit.opportunityId, tokenId: token!.id,
      strategyVersionId: version.id, stream: "AUTO_PAPER", sizingMode: "RISK_BASED",
      entryNotional: eur(25), entryAmountRaw: 1_000n, entryCostsMinor: 30n,
      openedAt: at, fromState: "OFFERED", sourceType: "LIVE",
    });
    if (offen.kind !== "OPENED") throw new Error("Position fehlt");

    expect(await requestPositionClose(db, { positionId: offen.positionId, actor: "dashboard", at }))
      .toMatchObject({ kind: "REQUESTED" });

    const [zeile] = await db.select().from(schema.paperPositions);
    expect(zeile?.closeRequestedAt).toEqual(at);
    // Der Kern: offen geblieben. Hier zu schliessen hiesse, einen
    // Ausstiegskurs zu erfinden.
    expect(zeile?.closedAt).toBeNull();
    expect(zeile?.exitReason).toBeNull();
    // Und `version` unberuehrt, sonst liefe eine gerade laufende Abrechnung
    // des Monitors ins Leere.
    expect(zeile?.version).toBe(0);

    // Ein zweiter Klick aendert nichts und sagt das.
    expect(await requestPositionClose(db, { positionId: offen.positionId, actor: "dashboard", at }))
      .toMatchObject({ kind: "ALREADY_REQUESTED" });

    expect(await cancelPositionClose(db, { positionId: offen.positionId, actor: "dashboard", at }))
      .toMatchObject({ kind: "REQUESTED" });
    const [zurueck] = await db.select().from(schema.paperPositions);
    expect(zurueck?.closeRequestedAt).toBeNull();

    const ereignisse = await db.select().from(schema.systemEvents);
    expect(ereignisse.map((e) => e.kind)).toContain("POSITION_CLOSE_REQUESTED");
    expect(ereignisse.map((e) => e.kind)).toContain("POSITION_CLOSE_CANCELLED");
  } finally { await close(); }
}, 60_000);

/**
 * Der Fehler, der 4.657 Auftraege umgebracht hat — als Test.
 *
 * `ensurePaperCandidateVersion` verlangt zu Recht, dass ein Versionsname genau
 * einen Parametersatz bezeichnet. Der Name trug aber nur Schwelle und Modus,
 * waehrend `maxMarketCapUsd` seit §149 ein Parameter war. Der Betreiber
 * aenderte die Groessengrenze im Dashboard — und ab diesem Moment starb jeder
 * `PAPER_SNIPER`-Auftrag mit „Stored candidate version differs or is retired",
 * ununterbrochen vom 2026-10-01 bis zum 2026-10-04.
 *
 * Es war kein Fehler der Pruefung. Es war ein Fehler des Namens.
 */
it("legt bei geaenderter Groessengrenze eine NEUE Version an statt zu werfen", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-10-04T12:00:00Z");

    // Genau die Abfolge aus dem Betrieb: erst laeuft es mit der
    // Voreinstellung, dann dreht der Betreiber an der Groessengrenze.
    const vorher = await ensurePaperCandidateVersion(
      db, at, paperCandidate(10, "OFFENSIV", { maxMarketCapUsd: 5_000_000 }),
    );
    const nachher = await ensurePaperCandidateVersion(
      db, at, paperCandidate(10, "OFFENSIV", { maxMarketCapUsd: 1_000_000 }),
    );

    expect(vorher.id).not.toBe(nachher.id);
    expect(vorher.version).not.toBe(nachher.version);
    expect(nachher.created).toBe(true);

    // Und ein zweiter Lauf mit denselben Einstellungen legt NICHTS Neues an.
    // Sonst entstuende bei jedem Takt eine Version, und die Buchfuehrung
    // zerfiele in tausend Einzelstuecke.
    const noch = await ensurePaperCandidateVersion(
      db, at, paperCandidate(10, "OFFENSIV", { maxMarketCapUsd: 1_000_000 }),
    );
    expect(noch.id).toBe(nachher.id);
    expect(noch.created).toBe(false);

    // Die Familie bleibt dieselbe — das Konto wechselt nicht.
    const familien = await db.select({ name: schema.strategies.name }).from(schema.strategies);
    expect(familien.map((f) => f.name)).toEqual([PAPER_STRATEGY_ID]);
  } finally { await close(); }
}, 60_000);

/**
 * Wenn es doch einmal abweicht, muss die Meldung sagen WO.
 *
 * Der Fingerabdruck macht den Parameterfall unmoeglich — aber eine
 * zurueckgezogene Version gibt es weiterhin, und ein von Hand uebergebener
 * Kandidat auch. Die alte Meldung war ein Satz fuer drei verschiedene Gruende,
 * und genau daran hat die Suche nach der Ursache vier Tage gehangen.
 */
it("nennt das abweichende Feld, nicht nur die Tatsache", async () => {
  const { db, close } = await createTestDatabase();
  try {
    const at = new Date("2026-10-04T12:00:00Z");
    const echt = paperCandidate(10, "OFFENSIV");
    await ensurePaperCandidateVersion(db, at, echt);

    // Derselbe Name, andere Parameter — nur von Hand herstellbar, denn der
    // Fingerabdruck wuerde den Namen mitziehen.
    const gefaelscht = {
      ...echt,
      parameters: {
        ...echt.parameters,
        entryGates: { ...echt.parameters.entryGates, maxTop10HolderSharePct: 42 },
      },
    };

    await expect(ensurePaperCandidateVersion(db, at, gefaelscht)).rejects.toThrow(
      /entryGates\.maxTop10HolderSharePct/,
    );
  } finally { await close(); }
}, 60_000);
