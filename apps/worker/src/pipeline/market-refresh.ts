import { systemClock, tokenId as asTokenId, type Clock } from "@sae/core";
import type { KnownProviderId } from "@sae/config";
import {
  PostgresCheckpointStore,
  SnapshotRepository,
  selectTrackedTokens,
  type Database,
  type IngestResult,
} from "@sae/db";
import { tally, type Logger } from "@sae/observability";
import { runResumable, snapshotSupportsEntry, type MarketDataAdapter } from "@sae/pipeline";
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
  readonly maxTokens: number;  /** Optional: Ablage fuer die Ablehnungsgruende der Marktauswahl. */
  readonly rejections?: {
    drain(): {
      reasons: Readonly<Record<string, number>>;
      quotes: Readonly<Record<string, number>>;
      exitProbes: Readonly<Record<string, number>>;
      tokens: number;
    };
  };
}

export interface MarketRefreshResult {
  readonly status: "OK" | "NO_TOKENS";
  readonly processed: number;
  readonly skipped: number;
  readonly ingested: number;
  readonly noSource: number;
  readonly rejected: number;
  readonly completed: boolean;
  /**
   * Wie viele der geschriebenen Snapshots eine Einstiegsentscheidung tragen
   * koennten.
   *
   * **Die aussagekraeftigste Zahl des Systems.** `ingested` sagt, dass Daten
   * ankommen; diese Zahl sagt, ob sie etwas WERT sind. Der Unterschied war ein
   * Jahr lang die ganze Geschichte dieses Projekts: die Kette lief, schrieb
   * Snapshots, und keiner davon kam je am Torwaechter vorbei — sichtbar wurde
   * das nirgends.
   *
   * Sie wird vom Torwaechter selbst gezaehlt, nicht nachgebaut.
   */
  readonly entryReady: number;
  /** Warum die uebrigen es nicht koennten. Leer, wenn alle es koennen. */
  readonly entryBlocked: Readonly<Record<string, number>>;
}

interface TokenUnit {
  readonly id: string;
  readonly mint: string;
}

/**
 * Ein Lauf.
 *
 * `jobKey` ist der Schluessel des CHECKPOINTS, nicht der des Auftrags — und
 * der Unterschied hat das ganze System zum Stillstand gebracht.
 *
 * Hier stand der Auftragsschluessel aus der Queue, mit der Begruendung, der
 * Checkpoint gehoere „genau zu diesem Takt". Der Auftragsschluessel traegt
 * aber das ZEITFENSTER des Takts und ist damit alle zwanzig Sekunden ein
 * anderer. Jeder Lauf lud folglich einen leeren Checkpoint und begann wieder
 * am Anfang der Liste — die nach `firstSeenAt DESC` sortiert ist.
 *
 * Wirkung im Betrieb: von 566 beobachteten Token wurden immer nur die
 * **fuenf juengsten** aufgefrischt. Die uebrigen 561 hat nach ihrer
 * Entdeckung nie wieder jemand angesehen. Im Log stand das die ganze Zeit
 * sichtbar da — `skipped: 0`, in jeder einzelnen Zeile. Ein rotierender Lauf
 * haette wachsende Zahlen gezeigt (§128).
 *
 * Der Schluessel identifiziert deshalb die ROTATION und nicht den Takt.
 * `runResumable` loescht ihn, sobald die Liste einmal durch ist — der
 * naechste Durchgang faengt dann von selbst neu an.
 */
export async function refreshMarketData(
  jobKey: string,
  deps: MarketRefreshDeps,
): Promise<MarketRefreshResult> {
  // Gefiltert und geordnet, seit die Discovery Zeilen anlegt: gesperrte und
  // vom Vorsieb verworfene Tokens weiter abzufragen kostet Anbieterbudget fuer
  // Tokens, gegen die sich das System bereits entschieden hat. Die Auswahl
  // steht in `selectTrackedTokens` und damit dort, wo auch der Rest der
  // Drizzle-Abfragen liegt.
  const rows = await selectTrackedTokens(deps.db, deps.maxTokens);

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
      entryReady: 0,
      entryBlocked: {},
    };
  }

  const snapshots = new SnapshotRepository(deps.db);
  let ingested = 0;
  let noSource = 0;
  let rejected = 0;
  let entryReady = 0;
  const entryBlocked: Record<string, number> = {};

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
            volume5mUsd: input.market.volume5mUsd,
            buys5m: input.market.buys5m,
            sells5m: input.market.sells5m,
            priceImpactBps: input.market.priceImpactBps,
            exitCapacityRatio: input.market.exitCapacityRatio,
            holders: input.market.holders,
          },
          observedAt: input.provenance.dataTimestamp,
          fetchedAt: input.provenance.sourceTimestamp,
          providerId: input.provenance.sourceProvider as never,
          tier: input.provenance.sourceTier ?? "FALLBACK",
          // Das echte Datenalter, unveraendert aus der Kette — bei
          // DexScreener `null`.
          //
          // Hier stand die Differenz `sourceTimestamp - dataTimestamp`. Beide
          // sind im Live-Pfad UNSERE Uhr (`dataTimestamp` ist
          // `Sourced.observedAt`, also unsere Kenntniszeit), und sie werden
          // im selben Abruf gesetzt. Die Differenz war deshalb immer ~0 —
          // jeder Snapshot einer Quelle ohne Zeitstempel wurde als
          // „null Sekunden alt" gespeichert. Genau davor warnt der Kommentar
          // in `snapshotSupportsEntry`: „Hier 0 anzunehmen hiesse, die
          // Pruefung abzuschaffen und sie gleichzeitig bestanden zu melden."
          // Der Gate hat richtig geprueft, er bekam nur nie ein `null` zu
          // sehen.
          freshnessSeconds: input.freshnessSeconds,
        },
      });

      if (result.kind === "ACCEPTED") {
        ingested += 1;

        // Derselbe Torwaechter, den die Entscheidung spaeter befragt — hier
        // nur gezaehlt, nicht angewendet. Fuer die HISTORIE wird alles
        // geschrieben; ob ein Snapshot eine Einstiegsentscheidung tragen
        // koennte, ist eine getrennte Frage, und sie war bisher nirgends
        // beantwortet.
        const gate = snapshotSupportsEntry({
          providerId: input.provenance.sourceProvider as never,
          tier: input.provenance.sourceTier ?? "FALLBACK",
          freshnessSeconds: input.freshnessSeconds,
          contributors: [],
        });
        if (gate.allowed) entryReady += 1;
        else {
          // Ausgeschrieben statt `(x ?? 0) + 1`: `sae/no-numeric-fallback`
          // kann einen Zaehler nicht von einem ersetzten Messwert
          // unterscheiden, und die Regel dafuer stillzulegen waere der
          // falsche Weg.
          const bisher = entryBlocked[gate.code];
          entryBlocked[gate.code] = bisher === undefined ? 1 : bisher + 1;
        }
      } else if (result.kind === "REJECTED") rejected += 1;
      return result;
    },
  });

  // `info`, sobald der Lauf tatsaechlich Tokens angefasst hat, sonst `debug`.
  //
  // Vorher stand die Zeile immer auf `debug` und war im Betrieb damit
  // unsichtbar — ausgerechnet die Meldung, an der man ablesen kann, ob
  // Snapshots entstehen. Die Discovery meldet sich auf `info`, dieser Schritt
  // gehoert daneben. Ohne Tokens bleibt es leise: eine Zeile alle 20 Sekunden,
  // die „nichts zu tun" sagt, verdeckt die, die etwas sagt.
  const level = run.processed > 0 ? "info" : "debug";
  // Die Gruende der Marktauswahl, sofern der Aufrufer eine Ablage gestellt
  // hat. Ohne sie sagt `noSource: 9` nur, DASS neun Token nichts geliefert
  // haben — die interessante Haelfte der Auskunft fehlte.
  const why = deps.rejections?.drain();
  deps.logger[level](
    {
      jobKey,
      processed: run.processed,
      skipped: run.skipped,
      ingested,
      noSource,
      rejected,
      // Die Zahl, auf die es ankommt — und ihre Kehrseite, sobald es eine gibt.
      entryReady,
      ...(Object.keys(entryBlocked).length > 0 ? { entryBlocked: tally(entryBlocked) } : {}),
      ...(why !== undefined && why.tokens > 0 ? { noSourceReasons: tally(why.reasons) } : {}),
      // Nur wenn es etwas zu sagen gibt: eine leere Zeile jede Minute ist
      // keine Auskunft, sondern Rauschen.
      ...(why !== undefined && Object.keys(why.quotes).length > 0
        ? { unusableQuotes: tally(why.quotes) }
        : {}),
      // Der Ausgang der Verkaufssonde. `OK=n` heisst: fuer n Token ist die
      // Ausstiegsfaehigkeit gemessen — die Zahl, ohne die das harte Tor jeden
      // Token ablehnt (§119).
      ...(why !== undefined && Object.keys(why.exitProbes).length > 0
        ? { exitProbe: tally(why.exitProbes) }
        : {}),
    },
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
    entryReady,
    entryBlocked,
  };
}

export { systemClock };
