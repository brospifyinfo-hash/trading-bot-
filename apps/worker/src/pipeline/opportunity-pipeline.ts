import { createHash } from "node:crypto";
import {
  assertProvenanceConsistent,
  bps,
  buildLatencyChain,
  eur,
  isTestFixture,
  money,
  type Clock,
  type DataProvenance,
  type Money,
  type StrategyVersionId,
  type SystemState,
  type TradingStream,
} from "@sae/core";
import type { StrategyParameters } from "@sae/config";
import {
  LatencyRepository,
  OpportunityRepository,
  PaperPositionRepository,
  type Database,
} from "@sae/db";
import { decide, type Decision, type DecisionContext } from "@sae/decision";
import { evaluateReadiness, planBranches, type Readiness } from "@sae/pipeline";
import { collectMissing, computeScores, type FeatureVector, type ScoringResult } from "@sae/scoring";
import type { Executor, ExecutionOutcome, ExecutionPlan } from "@sae/trading";
import type { ProviderFleetStatus } from "@sae/providers";

import { resolveMarketInput, type MarketInputRequest } from "./market-input";

/**
 * Der Pfad von einer Beobachtung zu zwei Stroemen.
 *
 * MARKTEINGABE → FEATURES → SCORING → ENTSCHEIDUNG → GELEGENHEIT
 *   → AUTO PAPER (simulierte Position)
 *   + MANUAL (Gelegenheit, die auf einen Menschen wartet)
 *
 * Die beiden Stroeme entstehen aus DERSELBEN Entscheidung und demselben
 * Feature-Snapshot, laufen danach aber vollstaendig getrennt. Das ist die
 * Voraussetzung fuer die Frage, die dieses System spaeter beantworten soll:
 * haette der Mensch besser entschieden als die Automatik? Zwei getrennt
 * erzeugte Gelegenheiten koennten das nicht beantworten, weil beide etwas
 * anderes gesehen haetten.
 *
 * Und der Unterschied, auf den es ankommt: **Auto oeffnet eine Position,
 * Manual nicht.** Eine Manual-Gelegenheit bleibt OFFERED, bis ein Mensch
 * reagiert. Sie automatisch zu oeffnen waere kein Abkuerzung, sondern eine
 * Faelschung der Manual-Statistik.
 */

/** Fester Einsatz je Paper-Trade (§12). */
export const PAPER_NOTIONAL: Money = eur(100);

export interface PipelineDeps {
  readonly db: Database;
  readonly clock: Clock;
  readonly strategyVersionId: StrategyVersionId;
  readonly parameters: StrategyParameters;
  readonly systemState: SystemState;
  readonly fleet: ProviderFleetStatus;
  /** Wie viele Snapshots die Historie enthaelt — geht in die Bereitschaft ein. */
  readonly snapshotCount: number;
  readonly minSnapshotsForAnalysis: number;
  /** Simulierte Ausfuehrung. Derselbe Executor wie im Backtest. */
  readonly executor: Executor;
  readonly outputMint: string;
  readonly inputMint: string;
  /** Wie lange eine Manual-Gelegenheit auf Antwort wartet. */
  readonly manualRespondMs: number;
  /** Zusatzangaben, die der Live-Pfad nicht selbst herleiten kann. */
  readonly decisionContext: Omit<
    DecisionContext,
    "features" | "scoring" | "parameters" | "decisionId" | "strategyVersionId"
  >;
}

export type PipelineOutcome =
  /** Keine Quelle hat geantwortet. Kein Signal, keine Gelegenheit, keine Position. */
  | { readonly kind: "NO_SOURCE"; readonly reason: string; readonly attempted: readonly string[] }
  /** Die Datenlage traegt keine Einstiegsentscheidung. */
  | { readonly kind: "BLOCKED"; readonly reason: string; readonly detail: string }
  /** Bewertet, aber kein Einstieg. Die Gelegenheit wird trotzdem festgehalten. */
  | {
      readonly kind: "NO_ENTRY";
      readonly decision: Decision;
      readonly created: readonly CreatedOpportunity[];
    }
  | {
      readonly kind: "ENTERED";
      readonly decision: Decision;
      readonly created: readonly CreatedOpportunity[];
      readonly autoPosition: AutoPaperResult;
    };

export interface CreatedOpportunity {
  readonly stream: TradingStream;
  readonly opportunityId: string;
  readonly snapshotId: string;
  /** `true`, wenn dieselbe Gelegenheit schon existierte — zweiter Lauf. */
  readonly duplicate: boolean;
}

export type AutoPaperResult =
  | { readonly kind: "OPENED"; readonly positionId: string; readonly outcome: ExecutionOutcome }
  | { readonly kind: "ALREADY_OPEN"; readonly positionId: string }
  /** Die simulierte Ausfuehrung ist gescheitert — kein Fill, keine Position. */
  | { readonly kind: "NOT_FILLED"; readonly outcome: ExecutionOutcome }
  | { readonly kind: "NOT_OFFERED"; readonly actualState: string | null };

function hashFeatures(vector: FeatureVector, engineVersion: string): string {
  // Stabil ueber denselben Vektor: derselbe Eingang ergibt denselben Schluessel,
  // und damit denselben Snapshot statt eines zweiten.
  return createHash("sha256")
    .update(JSON.stringify({ vector, engineVersion }))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Ein Durchlauf.
 *
 * Bewusst eine Funktion und keine Klasse mit Zustand: sie wird aus einem
 * Job-Handler aufgerufen, und ein Handler, der zwischen zwei Auftraegen etwas
 * im Speicher behaelt, ueberlebt keinen Neustart.
 */
export async function runOpportunityPipeline(
  request: MarketInputRequest,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  /* ---------------------------------------------- 1. Markteingabe */
  const input = await resolveMarketInput(request, deps.clock);
  if (input.kind === "NO_SOURCE") {
    // I: Ein Datenausfall darf niemals ein gueltiges Handelssignal erzeugen.
    // Hier endet der Durchlauf — ohne Gelegenheit, ohne Position.
    return { kind: "NO_SOURCE", reason: input.reason, attempted: input.attempted };
  }

  /* ---------------------------------------------- 2. Features */
  const features = input.features;
  if (features === null) {
    // Der Live-Pfad hat Marktdaten, aber noch keinen Feature-Vektor: der
    // entsteht aus der Historie ueber den PitReader, und die gibt es erst mit
    // genug Snapshots. Bis dahin ist das ein ehrliches BLOCKED und kein Fehler.
    return {
      kind: "BLOCKED",
      reason: "NO_FEATURE_VECTOR",
      detail:
        "Marktdaten vorhanden, aber der Feature-Vektor braucht Historie. Siehe BUILDING_HISTORY.",
    };
  }

  /* ---------------------------------------------- 3. Scoring */
  const scoring: ScoringResult = computeScores(features);

  /* ---------------------------------------------- 4. Bereitschaft */
  const readiness: Readiness = evaluateReadiness({
    fleet: deps.fleet,
    systemState: deps.systemState,
    snapshotCount: deps.snapshotCount,
    minSnapshotsForAnalysis: deps.minSnapshotsForAnalysis,
  });

  /* ---------------------------------------------- 5. Entscheidung */
  const decisionAt = deps.clock.now();
  const decision = decide({
    ...deps.decisionContext,
    decisionId: `dec-${hashFeatures(features, scoring.scoreEngineVersion)}` as DecisionContext["decisionId"],
    strategyVersionId: deps.strategyVersionId,
    features,
    scoring,
    parameters: deps.parameters,
  });

  /* ---------------------------------------------- 6. Verzweigung */
  // Hier wird planBranches tatsaechlich benutzt. Fuer den Fixture-Pfad wird die
  // Bereitschaft ueberschrieben: der Fixture BEWEIST die Verarbeitung, er
  // behauptet keine Marktlage. Die Ueberschreibung ist eng begrenzt und
  // ausdruecklich an die Fixture-Herkunft gebunden.
  const fixture = isTestFixture(input.provenance.sourceType);
  const effectiveReadiness: Readiness = fixture
    ? { ...readiness, canPaperTrade: true, canCreateOpportunities: true, canAnalyze: true }
    : readiness;

  const plan = planBranches({
    readiness: effectiveReadiness,
    systemState: deps.systemState,
    provenance:
      input.provenance.sourceTier === null
        ? null
        : {
            providerId: input.provenance.sourceProvider as never,
            tier: input.provenance.sourceTier,
            freshnessSeconds:
              (input.provenance.sourceTimestamp.getTime() -
                input.provenance.dataTimestamp.getTime()) /
              1_000,
            contributors: [],
          },
  });

  const paperStreams = plan.openStreams.filter(
    (s): s is Exclude<TradingStream, "LIVE"> => s !== "LIVE",
  );
  if (paperStreams.length === 0) {
    const blocked = plan.branches.find((b) => !b.open);
    return {
      kind: "BLOCKED",
      reason: blocked?.reason ?? "NO_STREAM",
      detail: blocked?.detail ?? "Kein Strom geoeffnet.",
    };
  }

  /* ---------------------------------------------- 7. Gelegenheiten */
  const provenance: DataProvenance = {
    ...input.provenance,
    decisionTimestamp: decisionAt,
    dataQuality: scoring.dataCompleteness,
  };
  assertProvenanceConsistent(provenance);

  const opportunities = new OpportunityRepository(deps.db);
  const created: CreatedOpportunity[] = [];

  for (const stream of paperStreams) {
    const result = await opportunities.create({
      tokenId: String(features.tokenId),
      provenance,
      stream,
      decisionKind: decision.kind,
      finalScore: decision.finalScore,
      reasons: decision.reasons,
      risks: decision.risks,
      rejectionReasons: decision.rejectionReasons,
      strategyVersionId: String(deps.strategyVersionId),
      decidedAt: decision.decidedAt,
      // Nur Manual bekommt ein Antwortfenster — Auto wartet auf niemanden.
      respondBy:
        stream === "MANUAL_PAPER"
          ? new Date(decision.decidedAt.getTime() + deps.manualRespondMs)
          : null,
      snapshot: {
        tokenId: String(features.tokenId),
        observedAt: features.asOf,
        features: features as unknown as Record<string, unknown>,
        missingFields: collectMissing(features).map((m) => `${m.field}:${m.reason}`),
        dataCompleteness: scoring.dataCompleteness,
        scoreEngineVersion: scoring.scoreEngineVersion,
        featureSetVersion: "1",
        inputHash: hashFeatures(features, scoring.scoreEngineVersion),
      },
    });

    if (result.kind === "CREATED") {
      created.push({
        stream,
        opportunityId: result.opportunityId,
        snapshotId: result.snapshotId,
        duplicate: false,
      });
    } else {
      // Zweiter Lauf desselben Ereignisses: die Datenbank hat die zweite Zeile
      // abgelehnt. Das ist der Nachweis der Idempotenz, kein Fehlerfall.
      created.push({
        stream,
        opportunityId: result.opportunityId,
        snapshotId: "",
        duplicate: true,
      });
    }
  }

  await recordLatency(deps, created, features.asOf, decision.decidedAt);

  /* ---------------------------------------------- 8. Auto Paper */
  // Kein ENTER heisst: die Gelegenheiten bleiben stehen (Forschungsmaterial),
  // aber es entsteht keine Position.
  if (decision.kind !== "ENTER") {
    return { kind: "NO_ENTRY", decision, created };
  }

  const auto = created.find((c) => c.stream === "AUTO_PAPER");
  if (auto === undefined) {
    return { kind: "NO_ENTRY", decision, created };
  }

  const autoPosition = await openAutoPaperPosition({
    deps,
    opportunityId: auto.opportunityId,
    tokenId: String(features.tokenId),
    provenance,
    decidedAt: decision.decidedAt,
  });

  /* ---------------------------------------------- 9. Manual bleibt offen */
  // Ausdruecklich KEINE Aktion fuer MANUAL_PAPER. Die Gelegenheit steht auf
  // OFFERED und wartet. Der Uebergang nach USER_CONFIRMED kommt von einem
  // Menschen, der Uebergang nach EXPIRED von der Zeit.

  return { kind: "ENTERED", decision, created, autoPosition };
}

/**
 * Oeffnet die simulierte Position — ueber den echten Executor.
 *
 * Nicht „100 € rein, X % raus": derselbe Quote, dasselbe Kostenmodell und
 * dieselbe Fehlschlagmechanik wie im Backtest. Scheitert die Ausfuehrung, gibt
 * es keine Position — auch das ist ein realistisches Ergebnis und darf nicht
 * wegsimuliert werden.
 */
async function openAutoPaperPosition(input: {
  readonly deps: PipelineDeps;
  readonly opportunityId: string;
  readonly tokenId: string;
  readonly provenance: DataProvenance;
  readonly decidedAt: Date;
}): Promise<AutoPaperResult> {
  const { deps } = input;

  const plan: ExecutionPlan = {
    intentId: `auto-${input.opportunityId}`,
    side: "buy",
    inputMint: deps.inputMint as ExecutionPlan["inputMint"],
    outputMint: deps.outputMint as ExecutionPlan["outputMint"],
    inAmount: PAPER_NOTIONAL.minor,
    notional: PAPER_NOTIONAL,
    maxSlippageBps: bps(deps.parameters.risk.maxSlippageBps),
    plannedAt: input.decidedAt,
  };

  const outcome = await deps.executor.execute(plan);
  if (outcome.kind !== "FILLED") {
    return { kind: "NOT_FILLED", outcome };
  }

  const positions = new PaperPositionRepository(deps.db);
  const opened = await positions.open({
    opportunityId: input.opportunityId,
    tokenId: input.tokenId,
    stream: "AUTO_PAPER",
    sizingMode: "FIXED_100",
    entryNotional: PAPER_NOTIONAL,
    entryAmountRaw: outcome.outAmount,
    strategyVersionId: String(deps.strategyVersionId),
    openedAt: outcome.filledAt,
    // Auto braucht keine Bestaetigung: die Gelegenheit geht direkt von OFFERED
    // in POSITION_OPENED. Manual verlangt USER_CONFIRMED — dort steht ein
    // Mensch dazwischen.
    fromState: "OFFERED",
    sourceType: input.provenance.sourceType,
    // Gebuehren, Preis-Impact und Latenzdrift aus dem Kostenmodell — dieselbe
    // Rechnung wie im Backtest und im Live-Pre-Check.
    entryCostsMinor: outcome.costs.total.minor,
  });

  if (opened.kind === "OPENED") {
    return { kind: "OPENED", positionId: opened.positionId, outcome };
  }
  if (opened.kind === "ALREADY_OPEN") {
    return { kind: "ALREADY_OPEN", positionId: opened.positionId };
  }
  return { kind: "NOT_OFFERED", actualState: opened.actualState };
}

/**
 * Schreibt die Zeitstempelkette, soweit sie ohne Live-Daten bekannt ist.
 *
 * Drei Stufen sind es heute: beobachtet, aufgenommen, entschieden. Die
 * spaeteren (ALERTED, SEEN, RESPONDED) entstehen erst, wenn ein Mensch reagiert.
 * Sie hier mit Schaetzwerten zu fuellen waere eine erfundene Latenz — und eine
 * erfundene Latenz macht jede spaetere Auswertung der echten wertlos.
 */
async function recordLatency(
  deps: PipelineDeps,
  created: readonly CreatedOpportunity[],
  observedAt: Date,
  decidedAt: Date,
): Promise<void> {
  const latency = new LatencyRepository(deps.db);
  const ingestedAt = deps.clock.now();
  const chain = buildLatencyChain({
    OBSERVED: observedAt,
    INGESTED: ingestedAt < decidedAt ? ingestedAt : decidedAt,
    DECIDED: decidedAt,
  });

  for (const opportunity of created) {
    if (opportunity.duplicate) continue;
    await latency.record({
      opportunityId: opportunity.opportunityId,
      stream: opportunity.stream,
      chain,
    });
  }
}

export { money };
