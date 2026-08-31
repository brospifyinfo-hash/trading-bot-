import { systemClock, tokenId as asTokenId } from "@sae/core";
import {
  JobQueueRepository,
  OpportunityRepository,
  ProviderHealthStore,
  type ClaimedJob,
  type Database,
} from "@sae/db";
import type { Logger } from "@sae/observability";
import { buildMarketDataChain, type MarketDataAdapter } from "@sae/pipeline";
import { loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";

import type { HandlerRegistry, JobHandler } from "./consumer";
import { resolveMarketInput } from "./pipeline/market-input";
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
  /** Geprüfte Adapter. Heute leer — ein Anbieter ohne Adapter kommt nicht in die Kette. */
  readonly adapters?: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
}

/** Ergebnis eines Auftrags, der auf Daten wartet statt welche zu erfinden. */
export interface WaitingResult {
  readonly status: "NO_SOURCE";
  readonly reason: string;
}

function waitingForData(reason: string): WaitingResult {
  return { status: "NO_SOURCE", reason };
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
        statusOf: () => "UNAVAILABLE",
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
        statusOf: () => "UNAVAILABLE",
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

export function buildHandlers(deps: HandlerDeps): HandlerRegistry {
  const market = (what: string): JobHandler => new MarketDataHandler(deps, what);
  return {
    SAMPLE_PROVIDER_HEALTH: new ProviderHealthHandler(deps),
    EXPIRE_OPPORTUNITIES: new ExpireOpportunitiesHandler(deps),
    DISCOVER_TOKENS: market("Token-Entdeckung"),
    REFRESH_MARKET_DATA: market("Marktdaten-Aktualisierung"),
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
