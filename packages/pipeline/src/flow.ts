import type { SystemState, TradingStream } from "@sae/core";
import type { ProviderFleetStatus } from "@sae/providers";

import type { SnapshotProvenance } from "./ingestion";
import { snapshotSupportsEntry } from "./ingestion";

/**
 * Was das System gerade tun darf — und woran es sonst haengt.
 *
 * Die Kette ist: Marktdaten → Discovery → Analyse → Gelegenheit → Paper.
 * Jede Stufe braucht die vorige, und die erste braucht eine erreichbare Quelle.
 * Fehlt sie, ist der Zustand nicht „Fehler", sondern `WAITING_FOR_MARKET_DATA` —
 * ein regulaerer Betriebszustand, in dem die Provider-Pruefung weiterlaeuft und
 * sonst nichts.
 *
 * Der Punkt, auf den es ankommt: **Paper haengt nicht am Live-Handel.** Sobald
 * Daten fliessen, laufen Auto Paper und Manual Opportunity an — unabhaengig
 * davon, ob jemals echtes Geld freigegeben wird. Andersherum waere die
 * Datenerhebung an eine Bedienentscheidung gekoppelt, und dann fehlen Daten
 * genau in den Phasen, in denen jemand aus Vorsicht abgeschaltet hat.
 */

export type PipelinePhase =
  /** Keine Quelle erreichbar. Nur die Provider-Pruefung laeuft. */
  | "WAITING_FOR_MARKET_DATA"
  /** Daten kommen an, aber die Historie reicht noch nicht zum Bewerten. */
  | "BUILDING_HISTORY"
  /** Vollstaendig: Discovery, Analyse, Gelegenheiten, Paper. */
  | "RUNNING";

export interface ReadinessInput {
  readonly fleet: ProviderFleetStatus;
  readonly systemState: SystemState;
  /** Wie viele Snapshots die Historie bereits enthaelt. */
  readonly snapshotCount: number;
  /** Ab wie vielen Snapshots ueberhaupt bewertet wird. */
  readonly minSnapshotsForAnalysis: number;
}

export interface Readiness {
  readonly phase: PipelinePhase;
  readonly canDiscover: boolean;
  readonly canIngest: boolean;
  readonly canAnalyze: boolean;
  readonly canCreateOpportunities: boolean;
  readonly canPaperTrade: boolean;
  readonly canLiveTrade: boolean;
  /** Klartext fuer die Anzeige. Nie leer. */
  readonly blockedBy: readonly string[];
}

export function evaluateReadiness(input: ReadinessInput): Readiness {
  const blockedBy: string[] = [];

  const dataUsable = input.fleet.anyMarketDataUsable;
  const dataConnected = input.fleet.anyMarketDataConnected;

  if (!dataUsable) blockedBy.push("Keine erreichbare Marktdatenquelle.");
  else if (!dataConnected) blockedBy.push("Marktdaten nur eingeschraenkt verfuegbar.");

  const enoughHistory = input.snapshotCount >= input.minSnapshotsForAnalysis;
  if (dataUsable && !enoughHistory) {
    blockedBy.push(
      `Historie zu duenn: ${input.snapshotCount} von ${input.minSnapshotsForAnalysis} Snapshots.`,
    );
  }

  // Der Notstopp haelt Live an — und ausdruecklich nicht die Beobachtung.
  if (input.systemState.emergencyStop) blockedBy.push("Notstopp aktiv: Live-Handel angehalten.");
  if (!input.systemState.liveTradingEnabled) blockedBy.push("Live-Handel nicht freigegeben.");

  const phase: PipelinePhase = !dataUsable
    ? "WAITING_FOR_MARKET_DATA"
    : enoughHistory
      ? "RUNNING"
      : "BUILDING_HISTORY";

  return {
    phase,
    canDiscover: dataUsable,
    canIngest: dataUsable,
    canAnalyze: dataUsable && enoughHistory,
    canCreateOpportunities: dataUsable && enoughHistory,
    // Paper laeuft, sobald es etwas zu bewerten gibt. Es fragt nicht nach Live.
    canPaperTrade: dataUsable && enoughHistory,
    // Live verlangt zusaetzlich eine Freigabe UND voll verbundene Daten.
    canLiveTrade:
      dataConnected &&
      enoughHistory &&
      input.systemState.liveTradingEnabled &&
      !input.systemState.emergencyStop,
    blockedBy: blockedBy.length > 0 ? blockedBy : ["Nichts blockiert."],
  };
}

/* --------------------------------------------------------- Verzweigung */

export type BranchReason =
  | "OK"
  | "NO_MARKET_DATA"
  | "INSUFFICIENT_HISTORY"
  | "DATA_QUALITY_TOO_LOW"
  | "LIVE_NOT_ENABLED"
  | "EMERGENCY_STOP";

export interface StreamBranch {
  readonly stream: TradingStream;
  readonly open: boolean;
  readonly reason: BranchReason;
  readonly detail: string;
}

export interface BranchPlan {
  readonly branches: readonly StreamBranch[];
  readonly openStreams: readonly TradingStream[];
  /** Ob aus dieser Entscheidung ueberhaupt etwas entsteht. */
  readonly producesAnything: boolean;
}

/**
 * Welche Stroeme aus einer Entscheidung eine Gelegenheit erhalten.
 *
 * Auto Paper und Manual Paper werden gemeinsam geoeffnet — sie sehen dieselbe
 * Entscheidung und denselben Feature-Snapshot. Getrennt erzeugt waere die
 * spaetere Frage „haette der Mensch besser entschieden als die Automatik"
 * nicht mehr beantwortbar, weil beide verschiedene Gelegenheiten gesehen
 * haetten.
 */
export function planBranches(input: {
  readonly readiness: Readiness;
  readonly systemState: SystemState;
  readonly provenance: SnapshotProvenance | null;
}): BranchPlan {
  const branches: StreamBranch[] = [];

  const dataVerdict =
    input.provenance === null
      ? { allowed: false, reason: "Kein Snapshot vorhanden." }
      : snapshotSupportsEntry(input.provenance);

  const paperOpen = input.readiness.canPaperTrade;
  const paperReason: BranchReason = paperOpen
    ? "OK"
    : input.readiness.phase === "WAITING_FOR_MARKET_DATA"
      ? "NO_MARKET_DATA"
      : "INSUFFICIENT_HISTORY";
  const paperDetail = paperOpen
    ? "Paper laeuft unabhaengig vom Live-Handel."
    : input.readiness.blockedBy.join(" ");

  for (const stream of ["AUTO_PAPER", "MANUAL_PAPER"] as const) {
    branches.push({ stream, open: paperOpen, reason: paperReason, detail: paperDetail });
  }

  // Live zusaetzlich: Freigabe, kein Notstopp, und Daten, die eine
  // Einstiegsentscheidung tragen duerfen.
  let liveReason: BranchReason = "OK";
  let liveDetail = "Live freigegeben und Datenlage ausreichend.";
  let liveOpen = true;

  if (!input.readiness.canPaperTrade) {
    liveOpen = false;
    liveReason = paperReason;
    liveDetail = paperDetail;
  } else if (input.systemState.emergencyStop) {
    liveOpen = false;
    liveReason = "EMERGENCY_STOP";
    liveDetail = "Notstopp aktiv.";
  } else if (!input.systemState.liveTradingEnabled) {
    liveOpen = false;
    liveReason = "LIVE_NOT_ENABLED";
    liveDetail = "Live-Handel nicht freigegeben.";
  } else if (!dataVerdict.allowed) {
    liveOpen = false;
    liveReason = "DATA_QUALITY_TOO_LOW";
    liveDetail = dataVerdict.reason;
  }

  branches.push({ stream: "LIVE", open: liveOpen, reason: liveReason, detail: liveDetail });

  const openStreams = branches.filter((b) => b.open).map((b) => b.stream);
  return { branches, openStreams, producesAnything: openStreams.length > 0 };
}

/* ------------------------------------------------- Gueltigkeit von Signalen */

export type SignalRejection =
  | "NO_MARKET_DATA"
  | "STALE_DATA"
  | "FALLBACK_DATA"
  | "NO_SNAPSHOT";

export type SignalValidity =
  | { readonly valid: true }
  | { readonly valid: false; readonly rejection: SignalRejection; readonly detail: string };

/**
 * Darf aus dieser Datenlage ein Handelssignal entstehen?
 *
 * Die technische Fassung von „ein Datenausfall darf niemals ein gueltiges
 * Handelssignal erzeugen". Bewusst als eigene Funktion und nicht als Teil der
 * Entscheidungsmaschine: sie wird VOR ihr aufgerufen, und ihr Ergebnis ist
 * nicht ueberstimmbar.
 */
export function signalValidity(input: {
  readonly fleet: ProviderFleetStatus;
  readonly provenance: SnapshotProvenance | null;
}): SignalValidity {
  if (!input.fleet.anyMarketDataUsable) {
    return {
      valid: false,
      rejection: "NO_MARKET_DATA",
      detail: input.fleet.summary,
    };
  }
  if (input.provenance === null) {
    return { valid: false, rejection: "NO_SNAPSHOT", detail: "Kein Snapshot fuer diesen Token." };
  }
  const verdict = snapshotSupportsEntry(input.provenance);
  if (!verdict.allowed) {
    return {
      valid: false,
      rejection: input.provenance.tier === "FALLBACK" ? "FALLBACK_DATA" : "STALE_DATA",
      detail: verdict.reason,
    };
  }
  return { valid: true };
}
