import { bps, eur, systemClock, tokenId as asTokenId, strategyVersionId as asStrategyVersionId, type Money } from "@sae/core";
import {
  DEFAULT_STRATEGY_PARAMETERS,
  DEFAULT_SYSTEM_STATE,
  type KnownProviderId,
} from "@sae/config";
import { estimateEv } from "@sae/decision";
import { computePositionSize } from "@sae/risk";
import { DEFAULT_FEES, DEFAULT_LATENCY } from "@sae/simulation";
import { PaperExecutor, type QuoteSource } from "@sae/trading";
import {
  summarizeFleet,
  type ProviderStatus,
  type ProviderStatusReport,
} from "@sae/providers";
import type { Logger } from "@sae/observability";
import { LivePitReader, type Database } from "@sae/db";
import type { MarketDataAdapter } from "@sae/pipeline";

import { runOpportunityPipeline, PAPER_NOTIONAL, type PipelineDeps } from "./opportunity-pipeline";

/**
 * Der Weg vom Snapshot zur Entscheidung — endlich aufgerufen.
 *
 * `runOpportunityPipeline` war seit Langem gebaut und getestet und wurde
 * **ausschliesslich aus Tests** aufgerufen. Die Auftragsart
 * `EVALUATE_OPPORTUNITY` zeigte auf den allgemeinen Marktdaten-Handler, der
 * Daten holte und das Ergebnis wegwarf.
 *
 * Das ist dieselbe Luecke wie bei der Discovery (DECISIONS §87), nur eine
 * Station weiter. Sie waere im unguenstigsten Moment aufgefallen: sobald ein
 * Preis ein bekanntes Alter hat, waere trotzdem nichts passiert — und die
 * Suche haette beim Anbieter angefangen, wo nichts kaputt ist.
 *
 * ### Was hier ehrlich zusammengesetzt wird — und was nicht
 *
 * Die Werte im Test-Aufbau (`harness.ts`) sind Konstanten: `eur(100)` als
 * Positionsgroesse, ein festes EV-Objekt. Fuer den Betrieb waere das
 * Erfindung. Hier kommen beide aus den ECHTEN Rechnern:
 *
 * - `computePositionSize` aus `@sae/risk`
 * - `estimateEv` aus `@sae/decision` — ohne abgeschlossene Trades liefert er
 *   von sich aus `UNKNOWN / INSUFFICIENT_SAMPLE`. Genau das ist die richtige
 *   Auskunft, und sie entsteht durch Rechnen und nicht durch Hinschreiben.
 *
 * Ausdruecklich KEINE Messung, sondern eine Festlegung der Simulation, ist der
 * Portfoliowert: es gibt kein echtes Depot. Er steht deshalb als benannte
 * Konstante neben `PAPER_NOTIONAL`, das dieselbe Rolle schon hatte.
 */

/**
 * Angenommenes Papier-Depot.
 *
 * Eine Festlegung, keine Messung — es gibt kein Konto, das man abfragen
 * koennte. Der Wert bestimmt ueber `riskPerTradePct` und `maxPositionPct`, wie
 * gross eine simulierte Position ausfaellt, und ist damit ein Parameter der
 * Simulation wie die Gebuehren. Er steht hier sichtbar und nicht tief in einer
 * Rechnung.
 */
export const PAPER_PORTFOLIO: Money = eur(3_000);

/** Ab wie vielen Snapshots eine Zeitreihe als analysierbar gilt. */
const MIN_SNAPSHOTS_FOR_ANALYSIS = 100;

/** Wie lange eine Manual-Gelegenheit auf Antwort wartet. */
const MANUAL_RESPOND_MS = 300_000;

export interface DecisionRunDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly tokenId: string;
  readonly mint: string;
  /** Der Anker, mit dem gekauft wird. */
  readonly quoteMint: string;
  /**
   * Ordergroesse in der kleinsten Einheit des Ankers.
   *
   * Vom Aufrufer aus den GELESENEN Dezimalstellen gerechnet, nicht hier aus
   * einer bekannten Zahl abgeschrieben. Ein Faktor 10^n daneben waere beim
   * Handeln der teuerste Fehler ueberhaupt.
   */
  readonly entryAmountRaw: bigint | null;
  readonly strategyVersionId: string;
  readonly snapshotCount: number;
  readonly providerReports: readonly ProviderStatusReport[];
  /**
   * Die Anbieterkette — dieselbe, mit der auch die Marktdaten aufgefrischt
   * werden.
   *
   * Hier stand `new Map()`, und daneben ein `statusOf`, das jeden Anbieter als
   * `UNAVAILABLE` meldete. Beides fest verdrahtet. Der Entscheidungslauf
   * konnte damit niemals an Marktdaten kommen: `resolveMarketInput` endete bei
   * JEDEM Token in `NO_SOURCE`, und der Durchlauf brach ab, bevor irgendeine
   * Regel geprueft wurde.
   *
   * Das ist dieselbe Luecke wie in DECISIONS §87 und §99 — gebaut, getestet,
   * nur nicht angeschlossen. Sie faellt nicht auf, weil `NO_SOURCE` ein
   * regulaeres Ergebnis ist und im Log genauso aussieht wie ein echter
   * Anbieterausfall.
   */
  readonly adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
  /** Fuer `tokenAgeSeconds` im Feature-Vektor. */
  readonly firstSeenAt: Date | null;
  /**
   * Woher die simulierte Ausfuehrung ihre Kurse nimmt.
   *
   * Ohne Quelle wird nicht ausgefuehrt — und ausdruecklich nicht geschaetzt.
   * Der Ausfuehrer wird erst gebraucht, wenn eine Entscheidung ueberhaupt bis
   * dahin kommt; bis dahin darf seine Abwesenheit den Lauf nicht verhindern,
   * denn dann bliebe der eigentliche Ablehnungsgrund unsichtbar.
   */
  readonly quotes: QuoteSource;
  /** Marktkapitalisierung des Tokens, fuer die Liquiditaetsgrenze der Groesse. */
  readonly liquidityUsd: number | null;
}

/**
 * Wie viel von der gemeldeten Liquiditaet eine Position hoechstens ausmachen darf.
 *
 * Eine Festlegung mit Begruendung: wer mehr als einen kleinen Bruchteil eines
 * Pools bewegt, bewegt den Preis gegen sich. Zwei Prozent ist der Wert, den
 * die Ausstiegs-Kapazitaetspruefung ohnehin voraussetzt.
 */
const MAX_POOL_SHARE = 0.02;

export async function runDecision(deps: DecisionRunDeps): Promise<{
  readonly outcome: string;
  readonly detail: string;
}> {
  const parameters = DEFAULT_STRATEGY_PARAMETERS;

  // Die Liquiditaetsgrenze der Positionsgroesse. Ohne bekannte Liquiditaet
  // gibt es keine Obergrenze aus dem Markt — dann bindet eine andere.
  const maxNotionalByLiquidity: Money =
    deps.liquidityUsd === null
      ? PAPER_PORTFOLIO
      : eur(Math.round(deps.liquidityUsd * MAX_POOL_SHARE * 100));

  const sizing = computePositionSize({
    portfolioValue: PAPER_PORTFOLIO,
    stopDistance: parameters.exit.stopLossBps / 10_000,
    maxNotionalByLiquidity,
    // Ohne Historie ist die Zuversicht nicht hoch, und sie wird auch nicht
    // dazu erklaert. Der EV-Rechner unten sagt dasselbe mit eigenen Worten.
    evConfidence: 0,
    minimumNotional: PAPER_NOTIONAL,
    parameters,
  });

  // Ohne abgeschlossene Trades liefert der Rechner von sich aus UNKNOWN. Das
  // ist die richtige Auskunft — und sie entsteht durch Rechnen.
  const ev = estimateEv({
    sample: [],
    expectedCostFraction: 0,
    minSampleSize: parameters.entryGates.minEvSampleSize,
  });

  const pipelineDeps: PipelineDeps = {
    db: deps.db,
    clock: systemClock,
    strategyVersionId: asStrategyVersionId(deps.strategyVersionId),
    parameters,
    systemState: DEFAULT_SYSTEM_STATE,
    fleet: summarizeFleet(deps.providerReports),
    snapshotCount: deps.snapshotCount,
    minSnapshotsForAnalysis: MIN_SNAPSHOTS_FOR_ANALYSIS,
    executor: new PaperExecutor({
      clock: systemClock,
      quotes: deps.quotes,
      fees: DEFAULT_FEES,
      latency: DEFAULT_LATENCY,
      solPrice: eur(150),
      dexFeeBps: bps(25),
      random: Math.random,
      driftSample: () => 0,
    }),
    // Gekauft wird MIT dem Anker, nicht mit dem Token selbst (§120).
    inputMint: deps.quoteMint,
    outputMint: deps.mint,
    entryAmountRaw: deps.entryAmountRaw,
    manualRespondMs: MANUAL_RESPOND_MS,
    decisionContext: {
      executionMode: "paper",
      decisionMode: "auto",
      // Bleibt aus: Live-Handel ist abgeschaltet und wird hier nicht
      // eingeschaltet.
      liveTradingEnabled: false,
      criticalProvidersUnavailable: [],
      tokenBlacklisted: false,
      hasOpenIntentOnMint: false,
      breakers: { open: [], entriesBlocked: false, allTradingBlocked: false, reasons: [] },
      sizing,
      ev,
      exposureViolations: [],
    },
  };

  const result = await runOpportunityPipeline(
    {
      kind: "LIVE",
      tokenId: asTokenId(deps.tokenId),
      mint: deps.mint,
      adapters: deps.adapters,
      statusOf: deps.statusOf,
      // Die Historie, aus der der Feature-Vektor entsteht. Live-Modus: der
      // Leser verlangt trotzdem bei jeder Abfrage ein `asOf` — die Vorkehrung
      // gegen Look-Ahead gilt in beiden Betriebsarten gleich.
      pit: new LivePitReader(deps.db, systemClock),
      firstSeenAt: deps.firstSeenAt,
      env: deps.env,
      allowDegraded: false,
    },
    pipelineDeps,
  );

  return { outcome: result.kind, detail: detailOf(result) };
}

function detailOf(result: Awaited<ReturnType<typeof runOpportunityPipeline>>): string {
  switch (result.kind) {
    case "NO_SOURCE":
      return result.reason;
    case "BLOCKED":
      // Der Fall, um den es heute geht: die Kette laeuft, und sie sagt, welches
      // Tor zu ist. Bisher stand hier gar nichts.
      return `${result.reason}: ${result.detail}`;
    default:
      return result.kind;
  }
}
