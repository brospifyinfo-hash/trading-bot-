import { systemClock, tokenId as asTokenId } from "@sae/core";
import {
  JobQueueRepository,
  OpportunityRepository,
  ProviderHealthStore,
  type ClaimedJob,
  type Database,
} from "@sae/db";
import type { Logger } from "@sae/observability";
import type { ProviderStatus } from "@sae/providers";
import { buildMarketDataChain, type MarketDataAdapter } from "@sae/pipeline";
import { loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";

import type { HandlerRegistry, JobHandler } from "./consumer";
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
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    void job;
    const result = await sampleProviderHealth({
      env: this.deps.env,
      store: new ProviderHealthStore(this.deps.db),
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
 * Marktdaten auffrischen — mit Wiederaufnahme.
 *
 * Der einzige Handler mit Checkpoint. Er braucht ihn, weil er eine Liste
 * abarbeitet: stirbt der Prozess in der Mitte, soll der naechste dort
 * weitermachen und nicht von vorn beginnen.
 */
class MarketRefreshHandler implements JobHandler {
  constructor(private readonly deps: HandlerDeps) {}

  async handle(job: ClaimedJob): Promise<unknown> {
    return refreshMarketData(job.dedupeKey, {
      db: this.deps.db,
      logger: this.deps.logger,
      env: this.deps.env,
      clock: systemClock,
      adapters: this.deps.adapters ?? new Map(),
      statusOf: statusOfFrom(this.deps),
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
 */
const MAX_TOKENS_PER_RUN = 25;
const MAX_TOKENS_TRACKED = 500;

export function buildHandlers(deps: HandlerDeps): HandlerRegistry {
  const market = (what: string): JobHandler => new MarketDataHandler(deps, what);
  return {
    SAMPLE_PROVIDER_HEALTH: new ProviderHealthHandler(deps),
    EXPIRE_OPPORTUNITIES: new ExpireOpportunitiesHandler(deps),
    REFRESH_MARKET_DATA: new MarketRefreshHandler(deps),
    DISCOVER_TOKENS: market("Token-Entdeckung"),
    SCORE_TOKEN: market("Bewertung"),
    EVALUATE_OPPORTUNITY: market("Gelegenheitspruefung"),
    MONITOR_PAPER_POSITION: market("Positionsueberwachung"),
    RECONCILE: market("Abgleich"),
    STRATEGY_HEALTH: market("Strategie-Gesundheit"),
    RESEARCH_BATCH: market("Forschungslauf"),
  };
}

export function jobQueueOf(db: Database): JobQueueRepository {
  return new JobQueueRepository(db);
}
