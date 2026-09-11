import { systemClock, tokenId as asTokenId } from "@sae/core";
import {
  countSnapshots,
  ensureActiveStrategyVersion,
  JobQueueRepository,
  OpportunityRepository,
  ProviderHealthStore,
  ProviderReadinessStore,
  selectTrackedTokens,
  type ClaimedJob,
  type Database,
} from "@sae/db";
import { tally, type Logger } from "@sae/observability";
import type { ProviderStatus, ProviderStatusReport } from "@sae/providers";
import { buildMarketDataChain, type MarketDataAdapter } from "@sae/pipeline";
import { DEFAULT_STRATEGY_PARAMETERS, loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";

import type { HandlerRegistry, JobHandler } from "./consumer";
import { buildQuoteSource } from "./pipeline/quote-source";
import { enrichSecurity } from "./pipeline/security-enrichment";
import { monitorPaperPositions } from "./pipeline/position-monitor";
import { QUOTE_ANCHOR_MINT } from "./pipeline/quote-market-source";
import { runDecision } from "./pipeline/decision-run";
import { buildAuthorityReader } from "./pipeline/authorities";
import { runTokenDiscovery } from "./pipeline/discovery-run";
import { resolveMarketInput } from "./pipeline/market-input";
import { refreshMarketData } from "./pipeline/market-refresh";
import { sampleProviderHealth } from "./roles/provider-health";

/**
 * Was die Handler ausfuehren — und was sie ausdruecklich nicht tun.
 *
 * Zwei Auftragsarten arbeiten heute vollstaendig, weil sie keine Marktdaten
 * brauchen: die Provider-Messung und der Ablauf von Gelegenheiten. Beide
 * schreiben echte Zeilen in die Datenbank.
 *
 * Alle uebrigen Arten haengen an einer erreichbaren Marktdatenquelle. Sie sind
 * verdrahtet, aber sie erfinden nichts: ist die Kette leer, ist das Ergebnis
 * `NO_SOURCE`, es entsteht kein Snapshot, kein Score, keine Gelegenheit. Das
 * ist ein regulaerer Abschluss und kein Fehler — ein Fehlschlag wuerde den
 * Auftrag ins Dead Letter tragen und dort jede Minute eine neue Zeile
 * hinterlassen, obwohl das System nur wartet.
 */

export interface HandlerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  /** Geprüfte Adapter. Ein Anbieter ohne Adapter kommt nicht in die Kette. */
  readonly adapters?: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  /**
   * Der gemessene Zustand je Anbieter.
   *
   * Fehlt die Funktion, gilt jeder Anbieter als `UNAVAILABLE`. Das ist
   * absichtlich die pessimistische Vorgabe: ohne Messung ist nichts bekannt,
   * und ein unbekannter Zustand darf keinen Abruf tragen. Der Consumer laedt
   * die Messreihe je Auftrag frisch aus der Datenbank — der Zustand kommt vom
   * provider-health-Dienst, nicht aus dem Speicher dieses Prozesses.
   */
  readonly statusOf?: (id: KnownProviderId) => ProviderStatus;
  /**
   * Ablage fuer die Ablehnungsgruende der Marktauswahl.
   *
   * Sie gehoert dem Prozess, der die Adapter baut (der Consumer), weil genau
   * der sie beim Bauen mitgibt. Fehlt sie, faellt nur die Begruendung im Log
   * weg — nichts am Verhalten.
   */
  readonly rejections?: {
    drain(): {
      reasons: Readonly<Record<string, number>>;
      quotes: Readonly<Record<string, number>>;
      tokens: number;
    };
  };
}

/** Ergebnis eines Auftrags, der auf Daten wartet statt welche zu erfinden. */
export interface WaitingResult {
  readonly status: "NO_SOURCE";
  readonly reason: string;
}

function waitingForData(reason: string): WaitingResult {
  return { status: "NO_SOURCE", reason };
}

/**
 * Der Anbieterzustand, den die Kette benutzen soll.
 *
 * Eine Funktion statt einer Methode je Handler-Klasse: die Vorgabe ist ein
 * Sicherheitsverhalten und darf nicht davon abhaengen, welche Klasse gerade
 * fragt. Ohne uebergebene Messung ist die Antwort `UNAVAILABLE` — ohne Messung
 * ist nichts bekannt, und ein unbekannter Zustand darf keinen Abruf tragen.
 */
function statusOfFrom(deps: HandlerDeps): (id: KnownProviderId) => ProviderStatus {
  return deps.statusOf ?? ((): ProviderStatus => "UNAVAILABLE");
}

class ProviderHealthHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    const result = await sampleProviderHealth({
      env: this.deps.env,
      store: new ProviderHealthStore(this.deps.db),
      readiness: new ProviderReadinessStore(this.deps.db),
      at: systemClock.now(),
    });
    return {
      status: "OK",
      written: result.written,
      marketDataConnected: result.marketDataConnected,
    };
  }
}

class ExpireOpportunitiesHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    // I-11: der Uebergang nach EXPIRED kommt von der Zeit, nicht vom naechsten
    // Login des Nutzers. Sonst waere eine abgelaufene Gelegenheit noch
    // bestaetigbar, solange niemand hinsieht.
    const expired = await new OpportunityRepository(this.deps.db).expireOverdue(systemClock.now());
    return { status: "OK", expired: expired.length };
  }
}

/**
 * Auftraege, die eine Marktdatenquelle brauchen.
 *
 * Die Kette wird bei JEDEM Auftrag neu aus der Konfiguration gebaut. Das ist
 * absichtlich: kommt ein Anbieter dazu, greift er beim naechsten Auftrag, ohne
 * dass der Worker neu startet.
 *
 * Der Abruf laeuft ueber `resolveMarketInput` und damit ueber
 * `fetchMarketFromChain` → `resolveFromChain`. Antwortet niemand, ist das
 * Ergebnis `NO_SOURCE` — kein Snapshot, keine Gelegenheit, keine Position.
 */
class MarketDataHandler implements JobHandler {
  // Er holt Marktdaten und verwirft das Ergebnis. Das ist heute vertretbar,
  // weil die Kette dahinter ohnehin am Datentor endet — aber es ist keine
  // Fertigmeldung, und die Einstufung sagt das.
  readonly wiring = "MARKET_DATA_ONLY" as const;
  constructor(
    private readonly deps: HandlerDeps,
    private readonly what: string,
  ) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    const mint = typeof job.payload["mint"] === "string" ? job.payload["mint"] : null;
    const tokenIdRaw = typeof job.payload["tokenId"] === "string" ? job.payload["tokenId"] : null;

    // Ohne Token im Auftrag gibt es nichts abzufragen. Die Discovery, die
    // Tokens einreiht, braucht selbst eine Quelle — deshalb ist das heute der
    // Regelfall und kein Fehler.
    if (mint === null || tokenIdRaw === null) {
      const chain = buildMarketDataChain({
        env: loadEnv(providerEnvSchema, this.deps.env),
        adapters: this.deps.adapters ?? new Map(),
        statusOf: statusOfFrom(this.deps),
      });
      this.deps.logger.debug(
        { kind: job.kind, note: chain.note },
        `${this.what} ohne Token im Auftrag`,
      );
      return waitingForData(chain.note);
    }

    const result = await resolveMarketInput(
      {
        kind: "LIVE",
        tokenId: asTokenId(tokenIdRaw),
        mint,
        adapters: this.deps.adapters ?? new Map(),
        // Ohne Messung gilt ein Anbieter als nicht erreichbar. Ein
        // optimistischer Startwert wuerde die Kette Anbieter fragen lassen,
        // die nachweislich nicht antworten.
        statusOf: statusOfFrom(this.deps),
        env: this.deps.env,
        // Fuer eine Einstiegsentscheidung reicht DEGRADED nicht.
        allowDegraded: false,
      },
      systemClock,
    );

    if (result.kind === "NO_SOURCE") {
      this.deps.logger.debug(
        { kind: job.kind, reason: result.reason, attempted: result.attempted },
        `${this.what} wartet auf eine Marktdatenquelle`,
      );
      return waitingForData(result.reason);
    }

    // Die Kette hat geantwortet. Der Weg von hier zu Features, Score und
    // Entscheidung laeuft ueber runOpportunityPipeline — er braucht den
    // PitReader fuer die Historie und ist deshalb an den Aufbau der
    // Snapshot-Reihe gebunden.
    return {
      status: "MARKET_DATA",
      provider: result.provenance.sourceProvider,
      tier: result.provenance.sourceTier,
      dataTimestamp: result.provenance.dataTimestamp.toISOString(),
    };
  }
}

/**
 * Token-Entdeckung.
 *
 * Der erste Handler, der keinen Mint im Auftrag braucht — er ist der, der
 * Mints erzeugt. Bis hierher lief `DISCOVER_TOKENS` in `MarketDataHandler`,
 * fand dort erwartungsgemaess keinen Token im Auftrag und meldete
 * `NO_SOURCE`. Die Kette war damit an ihrem Anfang unterbrochen: ohne Token
 * in der Tabelle meldete `refreshMarketData` dauerhaft `NO_TOKENS`, und alles
 * dahinter blieb leer.
 *
 * Der Lauf schreibt Zeilen in `tokens` und sonst nichts. Er trifft keine
 * Handelsentscheidung, legt keine Gelegenheit an und eroeffnet keine Position.
 */
class DiscoverTokensHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    return runTokenDiscovery({
      db: this.deps.db,
      logger: this.deps.logger,
      clock: systemClock,
      env: this.deps.env,
      statusOf: statusOfFrom(this.deps),
      // Die Autoritaetspruefung. Solange ihr Vertrag ungeprueft ist, fuehrt
      // sie die Anfrage aus und lehnt die Antwort ab — der Lauf zaehlt die
      // Luecke dann weiter unter `withoutAuthorityCheck`. Das ist der
      // gewuenschte Zwischenzustand: messbar, aber ohne Behauptung.
      checkAuthorities: buildAuthorityReader({
        clock: systemClock,
        rpcUrl: this.deps.env["SOLANA_RPC_URL"],
      }),
    });
  }
}

/**
 * Gelegenheitspruefung — der Weg vom Snapshot zur Entscheidung.
 *
 * Bis hierher zeigte diese Auftragsart auf den allgemeinen
 * Marktdaten-Handler: er holte Daten und warf das Ergebnis weg.
 * `runOpportunityPipeline` wurde ausschliesslich aus Tests aufgerufen.
 *
 * Der Lauf endet heute in aller Regel mit `BLOCKED` — die Marktdaten tragen
 * kein bekanntes Alter, und der Torwaechter laesst deshalb keine
 * Einstiegsentscheidung zu. Das ist kein Rueckschritt, sondern der Gewinn:
 * vorher passierte nichts und niemand erfuhr warum, jetzt steht im Log,
 * welches Tor zu ist.
 */
class EvaluateOpportunityHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    const url = this.deps.env["DATABASE_URL"];
    if (url === undefined) return waitingForData("Keine Datenbank konfiguriert.");

    // Die Strategieversion, auf die sich jede Entscheidung beruft. Sie fehlte
    // in der Produktionsdatenbank vollstaendig; ohne sie waere der erste
    // echte Entscheidungsversuch an einem Fremdschluessel gescheitert.
    const strategy = await ensureActiveStrategyVersion({
      db: this.deps.db,
      parameters: DEFAULT_STRATEGY_PARAMETERS,
      at: systemClock.now(),
    });
    if (strategy.created) {
      this.deps.logger.info(
        { role: "decision", version: strategy.version },
        "Strategieversion angelegt — Startparameter, ausdruecklich nicht validiert",
      );
    }

    const tokens = await selectTrackedTokens(this.deps.db, MAX_TOKENS_PER_RUN);
    if (tokens.length === 0) return waitingForData("Keine beobachteten Tokens.");

    // Die Anbieterlage aus den PERSISTIERTEN Messungen. Ohne Messung gilt ein
    // Anbieter als nicht erreichbar — dieselbe pessimistische Vorgabe wie
    // ueberall sonst.
    const reports: readonly ProviderStatusReport[] = (
      await new ProviderHealthStore(this.deps.db).latest()
    ).map((row) => ({
      providerId: row.providerId as never,
      kind: "market" as const,
      status: row.status as ProviderStatus,
      capabilities: [],
      lastSuccessAt: row.lastSuccessAt,
      lastFailureAt: row.lastFailureAt,
      lastFailureReason: row.lastFailureReason,
      latencyMsP50: row.latencyMsP50,
      latencyMsP95: row.latencyMsP95,
      rateLimit: null,
      // Aus der Messung uebernommen, nicht ersetzt: `null` heisst hier
      // ausdruecklich "noch nie etwas geliefert" und nicht "frisch".
      dataFreshnessSeconds: row.dataFreshnessSeconds,
      detail: row.detail,
    }));
    const snapshotCount = await countSnapshots(this.deps.db);

    // Einmal je Lauf und nicht je Token: der Adapter haelt keinen Zustand,
    // aber ihn zwoelfmal zu bauen waere zwoelfmal dieselbe Arbeit.
    //
    // Ohne JUPITER_BASE_URL bleibt es bei der Quelle, die nichts weiss. Das
    // ist die richtige Antwort und kein Notbehelf: ein geschaetzter
    // Einstiegskurs erzeugte Papier-Positionen mit erfundenen Einstiegen, und
    // die spaetere Statistik haette keine Chance, das noch zu bemerken.
    const quotes = buildQuoteSource(loadEnv(providerEnvSchema, this.deps.env));

    const outcomes: Record<string, number> = {};
    for (const token of tokens) {
      const result = await runDecision({
        db: this.deps.db,
        logger: this.deps.logger,
        env: this.deps.env,
        tokenId: token.id,
        mint: token.mint,
        strategyVersionId: strategy.id,
        snapshotCount,
        providerReports: reports,
        quotes,
        // Dieselbe Kette wie beim Auffrischen der Marktdaten. Hier stand
        // vorher eine leere Map — siehe die Begruendung an `DecisionRunDeps`.
        adapters: this.deps.adapters ?? new Map(),
        statusOf: this.deps.statusOf ?? ((): ProviderStatus => "UNAVAILABLE"),
        firstSeenAt: token.firstSeenAt,
        liquidityUsd: null,
      });
      const seen = outcomes[result.outcome];
      outcomes[result.outcome] = seen === undefined ? 1 : seen + 1;
    }

    this.deps.logger.info(
      { role: "decision", processed: tokens.length, reasons: tally(outcomes) },
      "Gelegenheiten geprueft",
    );
    return { status: "OK", processed: tokens.length, outcomes };
  }
}

/**
 * Marktdaten auffrischen — mit Wiederaufnahme.
 *
 * Der einzige Handler mit Checkpoint. Er braucht ihn, weil er eine Liste
 * abarbeitet: stirbt der Prozess in der Mitte, soll der naechste dort
 * weitermachen und nicht von vorn beginnen.
 */
class MarketRefreshHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    return refreshMarketData(job.dedupeKey, {
      db: this.deps.db,
      logger: this.deps.logger,
      env: this.deps.env,
      clock: systemClock,
      adapters: this.deps.adapters ?? new Map(),
      statusOf: statusOfFrom(this.deps),
      ...(this.deps.rejections !== undefined ? { rejections: this.deps.rejections } : {}),
      maxUnitsPerRun: MAX_TOKENS_PER_RUN,
      maxTokens: MAX_TOKENS_TRACKED,
    });
  }
}

/**
 * Wie viele Tokens ein Lauf anfasst.
 *
 * Festlegung, keine Messung: ohne bekannte Rate-Limit-Budgets ist jede Zahl
 * eine Annahme. Sie ist bewusst klein — zu wenige Anfragen kosten Zeit, zu
 * viele kosten den Zugang.
 *
 * Von 25 auf 10 gesenkt, und zwar gemessen: am 2026-09-11 endeten 21 von 25
 * Token mit `QUOTE_RATE_LIMITED`. Vier kamen durch. Seitdem bremst sich der
 * Quote-Pfad selbst auf eine Anfrage je Sekunde — und zehn Token passen damit
 * in den Zwanzig-Sekunden-Takt, fuenfundzwanzig nicht.
 *
 * Von 10 auf 5 nachgezogen, wieder gemessen: mit einer Anfrage je Sekunde
 * liefen immer noch 5 von 10 in die Drosselung. Fuenf Token bei hoechstens
 * vier Sekunden Abstand dauern 20 Sekunden — genau ein Takt, also nie
 * ueberlappend.
 *
 * Kein Token geht dadurch verloren: `runResumable` setzt beim naechsten Takt
 * dort fort, wo dieser aufgehoert hat. Ein Token wird damit rund einmal je
 * Minute aufgefrischt statt dreimal — bei vier brauchbaren Antworten je Lauf
 * war die hoehere Frequenz ohnehin eine Illusion.
 */
const MAX_TOKENS_PER_RUN = 5;
const MAX_TOKENS_TRACKED = 500;

/**
 * Sicherheitsbefunde nachladen.
 *
 * Eigener Handler und eigener Takt, weil der Anbieter bei 15 Anfragen
 * drosselt (Fenster unbekannt, gemessen 2026-09-10). Im Marktdaten-Handler
 * mitzulaufen hiesse, ihn sofort dichtzumachen — siehe DECISIONS §113.
 */
class EnrichSecurityHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    const env = loadEnv(providerEnvSchema, this.deps.env);
    const result = await enrichSecurity({
      db: this.deps.db,
      logger: this.deps.logger,
      ...(env.RUGCHECK_BASE_URL !== undefined ? { baseUrl: env.RUGCHECK_BASE_URL } : {}),
    });

    if (result.status === "NOT_CONFIGURED") {
      return waitingForData("Kein Sicherheitsanbieter konfiguriert (RUGCHECK_BASE_URL).");
    }
    return result;
  }
}

/**
 * Offene Papier-Positionen ueberwachen.
 *
 * Zeigte bis hierher auf den generischen Marktdaten-Handler: eine eroeffnete
 * Position waere nie ueberwacht und nie geschlossen worden. Siehe
 * DECISIONS §116.
 */
class MonitorPaperPositionHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    const env = loadEnv(providerEnvSchema, this.deps.env);
    return monitorPaperPositions({
      db: this.deps.db,
      logger: this.deps.logger,
      // Derselbe Anker, gegen den auch der Marktpreis gemessen wird.
      quoteMint: QUOTE_ANCHOR_MINT,
      quotes: buildQuoteSource(env),
    });
  }
}

export function buildHandlers(deps: HandlerDeps): HandlerRegistry {
  const market = (what: string): JobHandler => new MarketDataHandler(deps, what);
  return {
    SAMPLE_PROVIDER_HEALTH: new ProviderHealthHandler(deps),
    EXPIRE_OPPORTUNITIES: new ExpireOpportunitiesHandler(deps),
    REFRESH_MARKET_DATA: new MarketRefreshHandler(deps),
    DISCOVER_TOKENS: new DiscoverTokensHandler(deps),
    SCORE_TOKEN: market("Bewertung"),
    EVALUATE_OPPORTUNITY: new EvaluateOpportunityHandler(deps),
    MONITOR_PAPER_POSITION: new MonitorPaperPositionHandler(deps),
    RECONCILE: market("Abgleich"),
    STRATEGY_HEALTH: market("Strategie-Gesundheit"),
    RESEARCH_BATCH: market("Forschungslauf"),
    ENRICH_SECURITY: new EnrichSecurityHandler(deps),
  };
}

export function jobQueueOf(db: Database): JobQueueRepository {
  return new JobQueueRepository(db);
}
