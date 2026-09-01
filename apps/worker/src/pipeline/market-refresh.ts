import { systemClock, tokenId as asTokenId, type Clock } from "@sae/core";
import type { KnownProviderId } from "@sae/config";
import {
  PostgresCheckpointStore,
  SnapshotRepository,
  schema,
  type Database,
  type IngestResult,
} from "@sae/db";
import type { Logger } from "@sae/observability";
import { runResumable, type MarketDataAdapter } from "@sae/pipeline";
import type { ProviderStatus } from "@sae/providers";

import { resolveMarketInput } from "./market-input";

/**
 * Marktdaten auffrischen — mit Wiederaufnahme.
 *
 * Der Job arbeitet eine Tokenliste ab und schreibt nach JEDER Einheit einen
 * Checkpoint. Warum nach jeder und nicht am Ende: ein Prozess, der nach 60 von
 * 200 Tokens stirbt, soll beim naechsten Start bei 61 weitermachen und nicht
 * bei 1. Die 60 erneut abzufragen kostet Rate-Limit-Budget, das beim naechsten
 * Ausfall fehlt.
 *
 * Der Deckel `maxUnitsPerRun` ist die zweite Haelfte davon: ohne ihn kann ein
 * Lauf mit einer sehr langen Liste beliebig viele Anbieteranfragen erzeugen.
 * Mit ihm laeuft der Job ueber mehrere Takte, und jeder Takt hat eine
 * absehbare Obergrenze.
 */

export interface MarketRefreshDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
  /** Obergrenze je Lauf. Schuetzt das Rate-Limit-Budget. */
  readonly maxUnitsPerRun: number;
  readonly maxTokens: number;
}

export interface MarketRefreshResult {
  readonly status: "OK" | "NO_TOKENS";
  readonly processed: number;
  readonly skipped: number;
  readonly ingested: number;
  readonly noSource: number;
  readonly rejected: number;
  readonly completed: boolean;
}

interface TokenUnit {
  readonly id: string;
  readonly mint: string;
}

/**
 * Ein Lauf.
 *
 * `jobKey` ist der Auftragsschluessel aus der Queue. Er traegt das Zeitfenster
 * des Takts, also gehoert der Checkpoint genau zu diesem Takt — und wird nach
 * vollstaendiger Abarbeitung geloescht, damit der naechste Takt frisch anfaengt.
 */
export async function refreshMarketData(
  jobKey: string,
  deps: MarketRefreshDeps,
): Promise<MarketRefreshResult> {
  const rows = await deps.db
    .select({ id: schema.tokens.id, mint: schema.tokens.mint })
    .from(schema.tokens)
    .limit(deps.maxTokens);

  if (rows.length === 0) {
    // Kein Token bekannt. Das ist heute der Regelfall: die Discovery, die
    // Tokens einbringt, braucht selbst eine erreichbare Quelle.
    return {
      status: "NO_TOKENS",
      processed: 0,
      skipped: 0,
      ingested: 0,
      noSource: 0,
      rejected: 0,
      completed: true,
    };
  }

  const snapshots = new SnapshotRepository(deps.db);
  let ingested = 0;
  let noSource = 0;
  let rejected = 0;

  const run = await runResumable<TokenUnit, IngestResult | null>({
    jobKey,
    units: rows,
    unitId: (unit) => unit.id,
    store: new PostgresCheckpointStore(deps.db),
    clock: deps.clock,
    maxUnitsPerRun: deps.maxUnitsPerRun,
    process: async (unit) => {
      const input = await resolveMarketInput(
        {
          kind: "LIVE",
          tokenId: asTokenId(unit.id),
          mint: unit.mint,
          adapters: deps.adapters,
          statusOf: deps.statusOf,
          env: deps.env,
          // Fuer die Historie darf auch eine eingeschraenkte Quelle liefern —
          // eine EINSTIEGSENTSCHEIDUNG traegt sie deshalb noch lange nicht.
          // Das entscheidet spaeter `snapshotSupportsEntry`.
          allowDegraded: true,
        },
        deps.clock,
      );

      if (input.kind === "NO_SOURCE" || input.market === null) {
        noSource += 1;
        return null;
      }

      const result = await snapshots.ingest({
        tokenId: asTokenId(unit.id),
        clock: deps.clock,
        sourcedValue: {
          value: {
            priceUsd: input.market.priceUsd,
            liquidityUsd: input.market.liquidityUsd,
            marketCapUsd: input.market.marketCapUsd,
            volume24hUsd: input.market.volume24hUsd,
            holders: input.market.holders,
          },
          observedAt: input.provenance.dataTimestamp,
          fetchedAt: input.provenance.sourceTimestamp,
          providerId: input.provenance.sourceProvider as never,
          tier: input.provenance.sourceTier ?? "FALLBACK",
          freshnessSeconds:
            (input.provenance.sourceTimestamp.getTime() -
              input.provenance.dataTimestamp.getTime()) /
            1_000,
        },
      });

      if (result.kind === "ACCEPTED") ingested += 1;
      else if (result.kind === "REJECTED") rejected += 1;
      return result;
    },
  });

  deps.logger.debug(
    { jobKey, processed: run.processed, skipped: run.skipped, ingested, noSource },
    "Marktdaten aufgefrischt",
  );

  return {
    status: "OK",
    processed: run.processed,
    skipped: run.skipped,
    ingested,
    noSource,
    rejected,
    completed: run.completed,
  };
}

export { systemClock };
