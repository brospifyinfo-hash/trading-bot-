import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMissing, isPresent, missing, systemClock, tokenId as asTokenId } from "@sae/core";
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
  readonly exitCapacityRatio?: number | null;
}): Promise<void> {
  const at = new Date(T0.getTime() - input.minutesAgo * 60 * 1_000);
  await db.insert(schema.tokenSnapshots).values({
    tokenId: tokenUuid,
    observedAt: at,
    priceUsd: input.priceUsd,
    liquidityUsd: 180_000,
    marketCapUsd: 2_100_000,
    volume24hUsd: 95_000,
    volume5mUsd: 600,
    buys5m: 30,
    sells5m: 22,
    priceImpactBps: 120,
    // Was die Verkaufssonde misst (§119). Vorher gab es diese Spalte nicht,
    // und das Feld blieb im Vektor fehlend — mit Folgen bis ins harte Tor.
    exitCapacityRatio: input.exitCapacityRatio ?? 5,
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

  it("rechnet die Volumenbeschleunigung aus zwei gemessenen Fenstern", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: null,
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const beschleunigung = vector.momentum.volumeAcceleration;
    if (!isPresent(beschleunigung)) throw new Error("erwartet: Beschleunigung");
    // 95.000 am Tag sind im Schnitt 329,86 je Fuenf-Minuten-Fenster.
    // Gemessene 600 sind davon das 1,819-fache.
    expect(beschleunigung.value).toBeCloseTo(600 / (95_000 / 288), 6);
  });

  it("erfindet keine Beschleunigung ohne das Fuenf-Minuten-Fenster", async () => {
    // Aeltere Zeilen tragen die Spalte nicht — und aus dem Tagesvolumen allein
    // laesst sich die Groesse nicht bilden, nur eine aehnlich aussehende.
    const [row] = await db
      .insert(schema.tokens)
      .values({
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        discoverySource: "dexscreener",
        state: "SCREENING",
      })
      .returning({ id: schema.tokens.id });
    await db.insert(schema.tokenSnapshots).values({
      tokenId: row!.id,
      observedAt: T0,
      priceUsd: 1,
      volume24hUsd: 95_000,
      dataCompleteness: 0.3,
      sourceProviderId: "dexscreener",
      sourceTier: "SECONDARY",
      ingestKey: "test-ohne-m5",
    });

    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(row!.id),
      asOf: T0,
      firstSeenAt: null,
    });
    expect(isMissing(vector!.momentum.volumeAcceleration)).toBe(true);
    // Und ohne Preiseinfluss auch keine Kostenschaetzung: die Annahmen allein
    // ergaeben fuer jeden Token dieselbe Zahl.
    expect(isMissing(vector!.execution.expectedCostBps)).toBe(true);
  });

  it("rechnet die Ausfuehrungskosten aus dem gemessenen Preiseinfluss", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: null,
    });
    const kosten = vector!.execution.expectedCostBps;
    if (!isPresent(kosten)) throw new Error("erwartet: Kosten");
    // Groesser als der reine Preiseinfluss: Pool-Gebuehr, Kettenkosten und
    // Latenzdrift kommen dazu. Die genaue Zahl gehoert dem Kostenmodell —
    // hier wird geprueft, dass sie ueberhaupt daher kommt.
    expect(kosten.value).toBeGreaterThan(120);

    const impact = vector!.execution.priceImpactBps;
    if (!isPresent(impact)) throw new Error("erwartet: Preiseinfluss");
    expect(impact.value).toBe(120);
  });

  /**
   * Der Beleg fuer die Wegentscheidung.
   *
   * Ein einziges Feld von aussen — `top10HolderSharePct` — macht den
   * Sicherheits-Teilscore rechenbar und hebt die Gewichtsabdeckung von 0.50
   * auf 0.70. Erst damit bildet die Engine ueberhaupt einen Endscore.
   */
  it("erreicht mit einem Sicherheitsbefund die Gewichtsabdeckung", async () => {
    await db.insert(schema.tokenSecurity).values({
      tokenId: tokenUuid,
      observedAt: T0,
      checkVersion: "test",
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      top10HolderSharePct: 28.5,
    });

    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    const scores = computeScores(vector!);

    expect(scores.weightCoverage).toBeCloseTo(0.7, 6);
    expect(scores.notComputable).not.toContain("security");
    // Die Zahl, die es vorher nie gab.
    expect(scores.finalScore).not.toBeNull();
  });

  /**
   * Die Messung, um die es geht.
   *
   * Sie beantwortet nicht "funktioniert der Bauer", sondern "reicht das, was
   * dieses System erhebt, ueberhaupt fuer eine Einstiegsentscheidung".
   *
   * ### Der Weg dieser Zahl
   *
   * Sie stand lange unter der Schwelle, und zwar aus zwei Gruenden, die erst
   * getrennt sichtbar wurden:
   *
   * 1. Die Ausstiegsfaehigkeit wurde nie erhoben (§119). Das war ein echtes
   *    Datenloch und ist behoben — gemessen, nicht geraten.
   * 2. Die Kennzahl zaehlte sechs `pending`-Felder mit, fuer die es KEINE
   *    Quelle gibt (§121). Dieser Abzug traf jeden Token gleich und sagte
   *    nichts ueber ihn aus; er hat den Fortschritt der Entwicklung gemessen
   *    und Datenqualitaet dazu gesagt.
   *
   * Was dabei NICHT passiert ist: die Schwelle wurde nicht angefasst. Sie
   * steht unveraendert auf 0.7 — geaendert hat sich, was gezaehlt wird.
   */
  it("reicht mit den erhebbaren Feldern ueber die Schwelle", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const scores = computeScores(vector);
    const schwelle = DEFAULT_STRATEGY_PARAMETERS.entryGates.minDataCompleteness;

    expect(isPresent(vector.execution.exitCapacityRatio)).toBe(true);
    expect(scores.dataCompleteness).toBeGreaterThanOrEqual(schwelle);

    // Und die Luecke bleibt namentlich sichtbar — sie ist nicht
    // wegdefiniert, sondern an das richtige Instrument verschoben.
    const fehlend = scores.missingFields.map((m) => m.field);
    expect(fehlend).toContain("pending.smartMoneyBuyers");
    expect(fehlend).not.toContain("execution.exitCapacityRatio");
    expect(scores.weightCoverage).toBeLessThan(1);
  });

  it("waere ohne die Ausstiegsfaehigkeit noch ein Feld aermer", async () => {
    // Die Gegenprobe: dass die Zahl gestiegen ist, liegt an diesem Feld und
    // nicht an etwas anderem, das sich nebenbei geaendert hat.
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const ohne = {
      ...vector,
      execution: {
        ...vector.execution,
        exitCapacityRatio: missing("NOT_YET_COLLECTED" as const, T0, null),
      },
    };

    expect(computeScores(ohne).dataCompleteness).toBeLessThan(
      computeScores(vector).dataCompleteness,
    );
  });

  /**
   * Der zweite Gewinn, und der weniger offensichtliche.
   *
   * `liquidityScore` deckelt sich selbst bei 60, solange die
   * Ausstiegsfaehigkeit fehlt — „ohne Ausstiegsrechnung bleibt die Aussage
   * unvollstaendig". Dieser Deckel lag auf einem Teilscore mit Gewicht 0.15
   * und hat den Endscore mitgezogen.
   */
  it("nimmt dem Liquiditaets-Teilscore seinen Deckel", async () => {
    const vector = await buildFeatureVector({
      pit: reader(),
      tokenId: asTokenId(tokenUuid),
      asOf: T0,
      firstSeenAt: new Date(T0.getTime() - 6 * 60 * 60 * 1_000),
    });
    if (vector === null) throw new Error("erwartet: Vektor");

    const ohne = {
      ...vector,
      execution: {
        ...vector.execution,
        exitCapacityRatio: missing("NOT_YET_COLLECTED" as const, T0, null),
      },
    };

    const mit = computeScores(vector).finalScore;
    const kleiner = computeScores(ohne).finalScore;
    if (mit === null || kleiner === null) throw new Error("erwartet: Endscore");
    expect(mit).toBeGreaterThan(kleiner);
  });
});
