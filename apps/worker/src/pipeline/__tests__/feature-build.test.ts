import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMissing, isPresent, systemClock, tokenId as asTokenId } from "@sae/core";
import { LivePitReader, schema, type Database } from "@sae/db";
import { createTestDatabase } from "@sae/db/testing";
import { computeScores } from "@sae/scoring";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";

import { buildFeatureVector } from "../feature-build";

/**
 * Der Feature-Vektor aus der Historie.
 *
 * Wichtiger als der Erfolgsfall ist hier die Messung am Ende: wie vollstaendig
 * ist ein Vektor, der ausschliesslich aus dem entsteht, was dieses System
 * heute tatsaechlich erhebt? Die Antwort entscheidet, ob der Bot ueberhaupt
 * eine Position eroeffnen KANN — und sie wird gemessen, nicht geschaetzt.
 */

const T0 = new Date("2026-09-10T12:00:00Z");
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

let db: Database;
let close: () => Promise<void>;
let tokenUuid: string;

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [row] = await db
    .insert(schema.tokens)
    .values({
      mint: MEME,
      discoverySource: "dexscreener",
      state: "SCREENING",
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    })
    .returning({ id: schema.tokens.id });
  tokenUuid = row!.id;
});
afterAll(async () => {
  await close();
});

/** Ein Snapshot, wie ihn `market-refresh` heute schreibt. */
async function snapshot(input: {
  readonly minutesAgo: number;
  readonly priceUsd: number;
  readonly holders?: number | null;
}): Promise<void> {
  const at = new Date(T0.getTime() - input.minutesAgo * 60 * 1_000);
  await db.insert(schema.tokenSnapshots).values({
    tokenId: tokenUuid,
    observedAt: at,
    priceUsd: input.priceUsd,
    liquidityUsd: 180_000,
    marketCapUsd: 2_100_000,
    volume24hUsd: 95_000,
    holders: input.holders ?? null,
    dataCompleteness: 0.4,
    sourceProviderId: "jupiter-quote",
    sourceTier: "PRIMARY",
    sourceFreshnessSeconds: 8,
    ingestKey: `test-${String(input.minutesAgo)}`,
  });
}

function reader(): LivePitReader {
  return new LivePitReader(db, systemClock);
}

describe("Feature-Vektor aus der Historie", () => {
  it("gibt ohne einen einzigen Snapshot null zurueck", async () => {
    // Ein Vektor aus lauter Missing waere eine aufwendige Art, "keine Daten"
    // zu sagen — und flussabwaerts saehe er wie ein Qualitaetsproblem aus.
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: null,
    });
    expect(vector).toBeNull();
  });

  it("traegt Marktfelder mit Quelle und Zeitpunkt je Feld", async () => {
    await snapshot({ minutesAgo: 0, priceUsd: 0.00042, holders: 1_200 });

    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const preis = vector.market.priceUsd;
    if (!isPresent(preis)) throw new Error("erwartet: Preis");
    expect(preis.value).toBeCloseTo(0.00042, 9);
    // Die Herkunft ueberlebt bis ins einzelne Feld. Ohne sie waere nach der
    // Aggregation nicht mehr sagbar, worauf eine Entscheidung beruhte.
    expect(String(preis.source)).toBe("jupiter-quote");

    // `asOf` ist der Zeitpunkt der juengsten Messung, nicht "jetzt". Der
    // Unterschied IST das Alter der Daten und wird nicht wegdefiniert.
    expect(vector.asOf).toEqual(T0);

    const alter = vector.market.tokenAgeSeconds;
    if (!isPresent(alter)) throw new Error("erwartet: Alter");
    expect(alter.value).toBe(6 * 60 * 60);
  });

  it("rechnet Preisaenderungen aus der Reihe", async () => {
    await snapshot({ minutesAgo: 5, priceUsd: 0.0004 });
    await snapshot({ minutesAgo: 60, priceUsd: 0.0002 });

    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: null,
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const fuenf = vector.momentum.priceChange5m;
    if (!isPresent(fuenf)) throw new Error("erwartet: 5-Minuten-Aenderung");
    // 0,00042 gegen 0,00040 sind +5 %.
    expect(fuenf.value).toBeCloseTo(0.05, 9);

    const stunde = vector.momentum.priceChange1h;
    if (!isPresent(stunde)) throw new Error("erwartet: Stundenaenderung");
    expect(stunde.value).toBeCloseTo(1.1, 9);
  });

  it("erfindet nichts, wo die Reihe ein Loch hat", async () => {
    // Ein zweiter Token, der nur EINEN Snapshot hat: ohne Vergleichspunkt gibt
    // es keine Aenderung, und der naechstbeste Punkt waere eine
    // Fuenf-Minuten-Zahl ueber einen ganz anderen Zeitraum.
    const [row] = await db
      .insert(schema.tokens)
      .values({
        mint: "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj",
        discoverySource: "dexscreener",
        state: "SCREENING",
      })
      .returning({ id: schema.tokens.id });
    await db.insert(schema.tokenSnapshots).values({
      tokenId: row!.id,
      observedAt: T0,
      priceUsd: 0.001,
      liquidityUsd: 50_000,
      dataCompleteness: 0.3,
      sourceProviderId: "jupiter-quote",
      sourceTier: "PRIMARY",
      ingestKey: "test-einzeln",
    });

    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(row!.id),
      asOf: T0,
      firstSeenAt: null,
    });
    if (vector === null) throw new Error("erwartet: Vektor");
    expect(isMissing(vector.momentum.priceChange5m)).toBe(true);
    expect(isMissing(vector.momentum.priceChange1h)).toBe(true);
  });

  it("fuehrt einen fehlenden Sicherheitsbefund als NICHT ERHOBEN, nicht als unbedenklich", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: null,
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const mint = vector.security.mintAuthorityActive;
    expect(isMissing(mint)).toBe(true);
    if (!isMissing(mint)) return;
    // Der Unterschied, an dem alles haengt: "wir wissen es nicht" ist etwas
    // anderes als "die Autoritaet ist abgegeben". Ein `false` hier waere eine
    // Sicherheitsaussage, die niemand geprueft hat.
    expect(mint.reason).toBe("NOT_YET_COLLECTED");
  });

  /**
   * Die Messung, um die es geht.
   *
   * Sie beantwortet nicht "funktioniert der Bauer", sondern "reicht das, was
   * dieses System erhebt, ueberhaupt fuer eine Einstiegsentscheidung".
   */
  it("misst, wie vollstaendig ein Vektor aus heutigen Daten ist", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const scores = computeScores(vector);
    const schwelle = DEFAULT_STRATEGY_PARAMETERS.entryGates.minDataCompleteness;

    // Kein Wunschwert, sondern der gemessene: er haengt daran, wie viele
    // Felder dieses System heute ueberhaupt erhebt.
    expect(scores.dataCompleteness).toBeGreaterThan(0);
    expect(scores.dataCompleteness).toBeLessThan(schwelle);

    // Damit steht schwarz auf weiss, was noch fehlt — und zwar namentlich.
    expect(scores.missingFields.length).toBeGreaterThan(0);
  });
});
