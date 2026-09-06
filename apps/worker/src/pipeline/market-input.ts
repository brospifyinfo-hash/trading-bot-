import type { Clock, DataProvenance, TokenId } from "@sae/core";
import { TEST_FIXTURE_PROVIDER_PREFIX } from "@sae/core";
import { loadEnv, providerEnvSchema, type KnownProviderId } from "@sae/config";
import {
  buildMarketDataChain,
  fetchMarketFromChain,
  type MarketDataAdapter,
  type MarketFields,
} from "@sae/pipeline";
import type { FeatureVector } from "@sae/scoring";
import type { ProviderStatus } from "@sae/providers";

/**
 * Schritt 1 der Pipeline: woher kommen die Zahlen?
 *
 * Genau zwei Eingaenge, und sie sind bewusst nicht ineinander ueberfuehrbar:
 *
 *   LIVE          Die Anbieterkette wird aus der Konfiguration gebaut und
 *                 abgefragt. Antwortet niemand, ist das Ergebnis NO_SOURCE —
 *                 kein Ersatzwert, kein letzter bekannter Stand, nichts.
 *   TEST_FIXTURE  Ein ausdruecklich gekennzeichneter Eingabewert. Er geht
 *                 NICHT durch die Kette und ist kein Anbieter: er taucht in
 *                 keiner Provider-Health-Messung auf und faerbt keinen Status
 *                 auf CONNECTED. Sein einziger Zweck ist der Nachweis, dass die
 *                 Verarbeitung dahinter funktioniert.
 *
 * Die Trennung liegt im Typ, nicht in einer Konvention. Ein Fixture kann nicht
 * versehentlich als Live-Beobachtung durchgehen, weil er einen anderen Zweig
 * des Ergebnistyps traegt und eine Herkunft, die die Datenbank prueft.
 */

export interface LiveMarketRequest {
  readonly kind: "LIVE";
  readonly tokenId: TokenId;
  readonly mint: string;
  /** Geprüfte Adapter. Ohne Adapter kein Kettenmitglied. */
  readonly adapters: ReadonlyMap<KnownProviderId, MarketDataAdapter>;
  readonly statusOf: (id: KnownProviderId) => ProviderStatus;
  readonly env: NodeJS.ProcessEnv;
  /** Fuer eine Einstiegsentscheidung `false`: DEGRADED reicht dafuer nicht. */
  readonly allowDegraded: boolean;
}

/**
 * Ein Test-Fixture.
 *
 * Er traegt einen vollstaendigen Feature-Vektor und nicht nur Marktfelder.
 * Grund: aus reinen Marktdaten laesst sich die Gewichtsabdeckung der
 * Score-Engine nicht erreichen — der Live-Pfad wuerde dort ehrlich mit
 * DATA_INCOMPLETE abbrechen. Ein Fixture, der die Pipeline dahinter pruefen
 * soll, muss also weiter vorne einsteigen duerfen. Das ist zulaessig, WEIL er
 * als Fixture gekennzeichnet ist und nirgends als Messung zaehlt.
 */
export interface TestFixtureRequest {
  readonly kind: "TEST_FIXTURE";
  readonly tokenId: TokenId;
  /** Sprechendes Etikett, erscheint als `source_provider` in der Datenbank. */
  readonly label: string;
  readonly features: FeatureVector;
  /** Wann der Fixture eingespeist wurde. */
  readonly suppliedAt: Date;
}

export type MarketInputRequest = LiveMarketRequest | TestFixtureRequest;

export type MarketInputResult =
  | {
      readonly kind: "OK";
      readonly market: MarketFields | null;
      readonly provenance: Omit<DataProvenance, "decisionTimestamp">;
      /**
       * Das ECHTE Datenalter des Anbieters — `null`, wenn er keines liefert.
       *
       * Steht hier getrennt, weil `DataProvenance` es nicht traegt: dort gibt
       * es nur `sourceTimestamp` und `dataTimestamp`, und beide sind im
       * Live-Pfad UNSERE Uhr. Wer daraus die Differenz bildet, bekommt fuer
       * jeden Anbieter ohne Zeitstempel eine Null — also „taufrisch" fuer
       * genau die Daten, deren Alter niemand kennt.
       *
       * Der Wert kommt unveraendert aus `Sourced.freshnessSeconds` und wird
       * nirgends errechnet.
       */
      readonly freshnessSeconds: number | null;
      /** Nur beim Fixture gesetzt — der Live-Pfad baut die Features selbst. */
      readonly features: FeatureVector | null;
    }
  /** Keine Quelle hat geantwortet. Regulaeres Ergebnis, kein Fehler. */
  | {
      readonly kind: "NO_SOURCE";
      readonly reason: string;
      readonly attempted: readonly string[];
    };

/**
 * Holt die Marktdaten — ueber die Kette, wenn LIVE.
 *
 * Hier steht der Aufruf, der bis zuletzt gefehlt hat: `fetchMarketFromChain`
 * und damit `resolveFromChain`. Vorher wurde die Kette gebaut und nur ihre
 * Laenge geprueft; das ist der Unterschied zwischen „konstruiert" und
 * „benutzt".
 */
export async function resolveMarketInput(
  request: MarketInputRequest,
  clock: Clock,
): Promise<MarketInputResult> {
  if (request.kind === "TEST_FIXTURE") {
    return {
      kind: "OK",
      market: null,
      features: request.features,
      // Beim Fixture ist die Differenz eine echte Aussage: `asOf` ist ein
      // angegebener Datenzeitpunkt und nicht unsere Abrufzeit.
      freshnessSeconds:
        (request.suppliedAt.getTime() - request.features.asOf.getTime()) / 1_000,
      provenance: {
        sourceType: "TEST_FIXTURE",
        // Das Praefix ist nicht Kosmetik: eine CHECK-Constraint in der
        // Datenbank verlangt es. Ein Fixture ohne erkennbares Etikett kann
        // nicht gespeichert werden.
        sourceProvider: `${TEST_FIXTURE_PROVIDER_PREFIX}${request.label}`,
        sourceTier: null,
        sourceTimestamp: request.suppliedAt,
        dataTimestamp: request.features.asOf,
        dataQuality: 0,
      },
      };
  }

  const chain = buildMarketDataChain({
    env: loadEnv(providerEnvSchema, request.env),
    adapters: request.adapters,
    statusOf: request.statusOf,
  });

  if (chain.members.length === 0) {
    return { kind: "NO_SOURCE", reason: chain.note, attempted: [] };
  }

  const result = await fetchMarketFromChain({
    chain,
    mint: request.mint,
    clock,
    allowDegraded: request.allowDegraded,
  });

  if (result.kind === "NO_SOURCE") {
    return {
      kind: "NO_SOURCE",
      reason: result.reason,
      attempted: result.attempts.map((a) => `${String(a.providerId)}=${a.outcome}`),
    };
  }

  return {
    kind: "OK",
    market: result.data.value,
    features: null,
    // Unveraendert aus der Kette. Bei DexScreener ist das `null`.
    freshnessSeconds: result.data.freshnessSeconds,
    provenance: {
      sourceType: "LIVE",
      sourceProvider: String(result.data.providerId),
      sourceTier: result.data.tier,
      sourceTimestamp: clock.now(),
      // ACHTUNG beim Lesen: `observedAt` ist UNSERE Kenntniszeit, nicht die
      // Messzeit des Anbieters. Die Differenz zu `sourceTimestamp` ist
      // deshalb keine Frische, sondern die Dauer des eigenen Abrufs.
      dataTimestamp: result.data.observedAt,
      dataQuality: 0,
    },
  };
}
