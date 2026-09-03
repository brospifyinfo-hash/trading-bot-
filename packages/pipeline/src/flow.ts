import type { SystemState, TradingStream } from "@sae/core";
import type { ProviderFleetStatus } from "@sae/providers";

import type { SnapshotProvenance } from "./ingestion";
import { snapshotSupportsEntry } from "./ingestion";
import type { MarketDataFields } from "./market-data-quality";
import { assessMarketData, explainVerdict } from "./market-data-quality";

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
 * Was mit den Marktdaten dieses Durchlaufs geschehen soll.
 *
 * Zwei Faelle, und der zweite ist eng: ein Test-Fixture traegt keine
 * Marktdaten, weil er keine Marktlage behauptet — er beweist, dass die
 * Verarbeitung dahinter laeuft. Ihn durch die Qualitaetspruefung zu schicken
 * hiesse, ihn abzulehnen; ihm Marktdaten zu erfinden waere schlimmer. Also
 * traegt er einen eigenen Zweig, der in der Begruendung sichtbar bleibt und in
 * der Aufzeichnung landet.
 */
export type DataQualityCheck =
  | { readonly kind: "CHECK"; readonly market: MarketDataFields | null }
  /** Nur fuer ausdruecklich gekennzeichnete Fixtures. Nie fuer Live-Daten. */
  | { readonly kind: "WAIVED_TEST_FIXTURE"; readonly label: string };

export interface EntryDataVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

/**
 * Die vollstaendige Datenpruefung vor einer Gelegenheit.
 *
 * Sie fasst zwei Fragen zusammen, die vorher an verschiedenen Stellen und
 * unvollstaendig gestellt wurden:
 *
 * 1. **Woher und wie alt?** — `snapshotSupportsEntry` ueber die Herkunft.
 * 2. **Ist ueberhaupt drin, was gebraucht wird?** — `assessMarketData` ueber
 *    die Felder.
 *
 * Die zweite Frage fehlte. Ein Snapshot konnte PRIMARY und acht Sekunden alt
 * sein und trotzdem weder Liquiditaet noch Volumen enthalten; er passierte den
 * Gate, weil niemand hineinsah.
 */
export function entryDataVerdict(
  provenance: SnapshotProvenance | null,
  check: DataQualityCheck,
): EntryDataVerdict {
  if (check.kind === "WAIVED_TEST_FIXTURE") {
    return {
      allowed: true,
      reason: `Qualitaetspruefung ausgesetzt: Test-Fixture ${check.label}. Keine Marktaussage.`,
    };
  }

  if (provenance === null) {
    return { allowed: false, reason: "Kein Snapshot vorhanden." };
  }

  const origin = snapshotSupportsEntry(provenance);
  if (!origin.allowed) return origin;

  if (check.market === null) {
    return {
      allowed: false,
      reason: "Keine Marktdaten zu diesem Snapshot. Fehlend ist nicht null.",
    };
  }

  const verdict = assessMarketData({
    fields: check.market,
    tier: provenance.tier,
    freshnessSeconds: provenance.freshnessSeconds,
  });
  return verdict.kind === "PASS"
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: explainVerdict(verdict) };
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
  /**
   * Die Marktdaten, aus denen die Gelegenheit entstehen soll — oder der
   * ausdrueckliche Verzicht auf die Pruefung.
   *
   * Bewusst ein Pflichtfeld und eine unterschiedene Vereinigung, kein
   * optionaler Schalter: wer diese Funktion aufruft, muss sagen, ob echte
   * Marktdaten geprueft werden oder ob es sich um einen gekennzeichneten
   * Test-Fixture handelt. Ein weglassbares Feld waere ein Gate, das man durch
   * Vergessen umgeht — und genau das darf es hier nicht geben.
   */
  readonly dataQuality: DataQualityCheck;
}): BranchPlan {
  const branches: StreamBranch[] = [];

  const dataVerdict = entryDataVerdict(input.provenance, input.dataQuality);

  // Die Datenqualitaet gilt fuer JEDEN Strom, nicht nur fuer Live.
  //
  // Vorher haing Paper allein an Bereitschaft und Historienlaenge: erreichbare
  // Quelle plus genug Snapshots reichten, und ob DIESER Datensatz die noetigen
  // Felder trug, fragte niemand. Damit konnte eine Gelegenheit aus einem
  // Snapshot ohne Liquiditaet und ohne Volumen entstehen — und weil Paper die
  // Grundlage der spaeteren Statistik ist, waere diese Statistik auf Loechern
  // gebaut. Eine Auswertung, die nicht unterscheidet, ob ein Feld fehlte oder
  // null war, beantwortet keine einzige Frage ueber den Markt.
  const paperOpen = input.readiness.canPaperTrade && dataVerdict.allowed;
  const paperReason: BranchReason = paperOpen
    ? "OK"
    : !input.readiness.canPaperTrade
      ? input.readiness.phase === "WAITING_FOR_MARKET_DATA"
        ? "NO_MARKET_DATA"
        : "INSUFFICIENT_HISTORY"
      : "DATA_QUALITY_TOO_LOW";
  // Bei offener Verzweigung traegt der Text den Verzicht mit, falls einer
  // vorliegt. Ein ausgesetzter Gate, der in der Aufzeichnung wie ein
  // bestandener aussieht, ist schlimmer als gar keine Aufzeichnung.
  const paperDetail = paperOpen
    ? input.dataQuality.kind === "WAIVED_TEST_FIXTURE"
      ? dataVerdict.reason
      : "Paper laeuft unabhaengig vom Live-Handel."
    : !input.readiness.canPaperTrade
      ? input.readiness.blockedBy.join(" ")
      : dataVerdict.reason;

  for (const stream of ["AUTO_PAPER", "MANUAL_PAPER"] as const) {
    branches.push({ stream, open: paperOpen, reason: paperReason, detail: paperDetail });
  }

  // Live zusaetzlich: Freigabe und kein Notstopp. Die Datenlage ist an dieser
  // Stelle bereits geprueft — sie war Voraussetzung fuer Paper.
  let liveReason: BranchReason = "OK";
  let liveDetail = "Live freigegeben und Datenlage ausreichend.";
  let liveOpen = true;

  if (!paperOpen) {
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
  | "NO_SNAPSHOT"
  /** Snapshot da, Herkunft in Ordnung — aber ein Pflichtfeld fehlt. */
  | "INCOMPLETE_MARKET_DATA";

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
 *
 * Ein Datenausfall ist dabei nicht nur eine Quelle, die schweigt. Eine Quelle,
 * die antwortet und dabei die Haelfte der Felder weglaesst, ist derselbe Fall:
 * die Zahlen, auf denen das Signal beruhen soll, sind nicht da. Deshalb prueft
 * diese Funktion seit dieser Aenderung auch die Felder und nicht nur die
 * Herkunft.
 */
export function signalValidity(input: {
  readonly fleet: ProviderFleetStatus;
  readonly provenance: SnapshotProvenance | null;
  readonly market: MarketDataFields | null;
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

  const origin = snapshotSupportsEntry(input.provenance);
  if (!origin.allowed) {
    return {
      valid: false,
      rejection: input.provenance.tier === "FALLBACK" ? "FALLBACK_DATA" : "STALE_DATA",
      detail: origin.reason,
    };
  }

  if (input.market === null) {
    return {
      valid: false,
      rejection: "INCOMPLETE_MARKET_DATA",
      detail: "Keine Marktdaten zu diesem Snapshot. Fehlend ist nicht null.",
    };
  }

  const verdict = assessMarketData({
    fields: input.market,
    tier: input.provenance.tier,
    freshnessSeconds: input.provenance.freshnessSeconds,
  });
  if (verdict.kind !== "PASS") {
    return {
      valid: false,
      // Veraltet und Fallback sind oben schon abgefangen; was hier noch
      // uebrig bleibt, ist eine Aussage ueber die Felder selbst.
      rejection: "INCOMPLETE_MARKET_DATA",
      detail: explainVerdict(verdict),
    };
  }

  return { valid: true };
}
