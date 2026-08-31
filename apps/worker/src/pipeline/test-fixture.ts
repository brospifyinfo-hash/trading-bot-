import { observed, providerId, tokenId as asTokenId, type TokenId } from "@sae/core";
import type { FeatureVector } from "@sae/scoring";

import type { TestFixtureRequest } from "./market-input";

/**
 * Test-Fixtures — und was sie ausdruecklich NICHT sind.
 *
 * Ein Fixture ist ein Eingabewert, mit dem sich nachweisen laesst, dass die
 * Verarbeitung funktioniert. Er ist:
 *
 *   - KEINE Marktdatenquelle. Er geht nicht durch die Anbieterkette, taucht in
 *     keiner Provider-Health-Messung auf und faerbt keinen Anbieter auf
 *     CONNECTED.
 *   - KEINE Handelsleistung. Alles, was aus ihm entsteht, traegt
 *     `source_type = 'TEST_FIXTURE'` und `is_test_fixture = true`. Die
 *     Datenbank haelt das ueber CHECK-Constraints und zusammengesetzte
 *     Fremdschluessel durch — nicht dieser Kommentar.
 *   - KEIN Grund fuer eine Strategiefreigabe. Die Promotionsgates zaehlen nur
 *     Datensaetze mit LIVE-Herkunft.
 *
 * Dass diese Datei im Produktionscode liegt und nicht in `__tests__`, ist
 * Absicht: der Fixture-Pfad muss ueber DIESELBE Pipeline laufen wie der echte,
 * sonst beweist er nichts ueber sie. Der Schutz liegt nicht darin, den Pfad zu
 * verstecken, sondern darin, dass alles aus ihm markiert ist.
 */

/** Ein Feature-Vektor, in dem jedes Feld vorhanden ist. */
export interface FixtureFeatureValues {
  readonly priceUsd: number;
  readonly liquidityUsd: number;
  readonly marketCapUsd: number;
  readonly volume24hUsd: number;
  readonly tokenAgeSeconds: number;
  readonly priceChange5m: number;
  readonly priceChange1h: number;
  readonly volumeAcceleration: number;
  readonly buys5m: number;
  readonly sells5m: number;
  readonly holders: number;
  readonly holderGrowth: number;
  readonly distinctActors: number;
  readonly largestClusterSharePct: number;
  readonly top10HolderSharePct: number;
  readonly topHolderSharePct: number;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly expectedCostBps: number;
  readonly exitCapacityRatio: number;
  readonly priceImpactBps: number;
  readonly smartMoneyBuyers: number;
  readonly smartMoneySellers: number;
  readonly socialAuthenticity: number;
  readonly socialMomentum: number;
  readonly devScore: number;
  readonly narrativeScore: number;
}

/**
 * Ein Fixture, der eine Einstiegsentscheidung tragen wuerde.
 *
 * Die Werte sind bewusst gutmuetig gewaehlt — das ist der Punkt: der Test soll
 * die Verarbeitung eines ENTER pruefen. Sie sind KEINE Behauptung ueber einen
 * realen Token und werden nirgends als Messung gefuehrt.
 */
export const ENTRY_GRADE_FIXTURE: FixtureFeatureValues = {
  priceUsd: 0.000_42,
  liquidityUsd: 180_000,
  marketCapUsd: 900_000,
  volume24hUsd: 450_000,
  tokenAgeSeconds: 7_200,
  priceChange5m: 0.08,
  priceChange1h: 0.22,
  volumeAcceleration: 2.4,
  buys5m: 180,
  sells5m: 60,
  holders: 1_400,
  holderGrowth: 260,
  distinctActors: 1_180,
  largestClusterSharePct: 4.2,
  top10HolderSharePct: 18,
  topHolderSharePct: 3.5,
  riskLevel: "LOW",
  expectedCostBps: 95,
  exitCapacityRatio: 6.5,
  priceImpactBps: 45,
  smartMoneyBuyers: 7,
  smartMoneySellers: 1,
  socialAuthenticity: 0.72,
  socialMomentum: 0.61,
  devScore: 68,
  narrativeScore: 55,
};

/** Die Quelle im Feature-Vektor. Auch dort ist die Herkunft ablesbar. */
const SOURCE = providerId("TEST_FIXTURE");

/** Baut einen vollstaendigen Feature-Vektor aus Fixture-Werten. */
export function fixtureFeatureVector(input: {
  readonly tokenId: TokenId;
  readonly asOf: Date;
  readonly values?: Partial<FixtureFeatureValues>;
}): FeatureVector {
  const v: FixtureFeatureValues = { ...ENTRY_GRADE_FIXTURE, ...input.values };
  const at = input.asOf;
  // `present` traegt Quelle und Beobachtungszeitpunkt je Feld. Die Quelle heisst
  // hier TEST_FIXTURE — auch im Feature-Vektor ist die Herkunft ablesbar.
  const p = <T>(value: T) => observed(value, SOURCE, at);

  return {
    tokenId: input.tokenId,
    asOf: at,
    security: {
      mintAuthorityActive: p(false),
      freezeAuthorityActive: p(false),
      lpBurnedOrLocked: p(true),
      top10HolderSharePct: p(v.top10HolderSharePct),
      topHolderSharePct: p(v.topHolderSharePct),
      riskLevel: p(v.riskLevel),
    },
    market: {
      priceUsd: p(v.priceUsd),
      liquidityUsd: p(v.liquidityUsd),
      marketCapUsd: p(v.marketCapUsd),
      volume24hUsd: p(v.volume24hUsd),
      tokenAgeSeconds: p(v.tokenAgeSeconds),
    },
    momentum: {
      priceChange5m: p(v.priceChange5m),
      priceChange1h: p(v.priceChange1h),
      volumeAcceleration: p(v.volumeAcceleration),
      buys5m: p(v.buys5m),
      sells5m: p(v.sells5m),
    },
    holder: {
      holders: p(v.holders),
      holderGrowth: p(v.holderGrowth),
      distinctActors: p(v.distinctActors),
      largestClusterSharePct: p(v.largestClusterSharePct),
    },
    execution: {
      expectedCostBps: p(v.expectedCostBps),
      exitCapacityRatio: p(v.exitCapacityRatio),
      priceImpactBps: p(v.priceImpactBps),
    },
    pending: {
      smartMoneyBuyers: p(v.smartMoneyBuyers),
      smartMoneySellers: p(v.smartMoneySellers),
      socialAuthenticity: p(v.socialAuthenticity),
      socialMomentum: p(v.socialMomentum),
      devScore: p(v.devScore),
      narrativeScore: p(v.narrativeScore),
    },
  };
}

/** Baut die Pipeline-Anfrage fuer einen Fixture-Durchlauf. */
export function testFixtureRequest(input: {
  readonly tokenId: string;
  readonly label: string;
  readonly asOf: Date;
  readonly suppliedAt?: Date;
  readonly values?: Partial<FixtureFeatureValues>;
}): TestFixtureRequest {
  const id = asTokenId(input.tokenId);
  return {
    kind: "TEST_FIXTURE",
    tokenId: id,
    label: input.label,
    features: fixtureFeatureVector({
      tokenId: id,
      asOf: input.asOf,
      ...(input.values !== undefined ? { values: input.values } : {}),
    }),
    suppliedAt: input.suppliedAt ?? input.asOf,
  };
}
