import { describe, expect, it } from "vitest";
import {
  MIN_WEIGHT_COVERAGE,
  SCORE_ENGINE_VERSION,
  WEIGHTS,
  assertWeightsSumToOne,
  computeScores,
} from "../v1/engine";
import { gone, healthyToken, val } from "./fixtures";

describe("Score-Engine v1", () => {
  it("summiert die Gewichte zu genau 1", () => {
    // Ein Tippfehler im Gewicht wuerde sonst still die ganze Skala verschieben.
    expect(() => assertWeightsSumToOne()).not.toThrow();
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("haengt die Version an jedes Ergebnis", () => {
    expect(computeScores(healthyToken()).scoreEngineVersion).toBe(SCORE_ENGINE_VERSION);
  });

  it("liefert einen stabilen Endscore (Golden File)", () => {
    // Aendert sich dieser Wert unbeabsichtigt, sind alte und neue Scores nicht
    // mehr vergleichbar — und jede Faktoranalyse darueber waere falsch.
    //
    // `dataCompleteness` stand hier auf 0.7931 und steht jetzt auf 1. Der
    // Unterschied ist keine bessere Datenlage, sondern eine andere Frage:
    // gezaehlt wird seit §121 nur noch, was dieses System erhebt. Deshalb
    // traegt jedes Ergebnis `scoreEngineVersion` 1.1.0 — sonst stuenden zwei
    // Groessen unter einem Namen.
    const result = computeScores(healthyToken());
    expect({
      finalScore: result.finalScore,
      weightCoverage: Number(result.weightCoverage.toFixed(4)),
      dataCompleteness: Number(result.dataCompleteness.toFixed(4)),
      notComputable: [...result.notComputable].sort(),
    }).toMatchInlineSnapshot(`
      {
        "dataCompleteness": 1,
        "finalScore": 80,
        "notComputable": [
          "dev",
          "narrative",
          "smartMoney",
          "social",
        ],
        "weightCoverage": 0.7,
      }
    `);
  });

  it("gibt keinen Endscore aus, wenn zu wenig Gewicht abgedeckt ist", () => {
    // Zwei von neun Teilscores ergeben keine Zahl, sondern eine Behauptung.
    const v = healthyToken();
    const result = computeScores({
      ...v,
      security: { ...v.security, mintAuthorityActive: gone() },
      market: { ...v.market, liquidityUsd: gone() },
      momentum: { ...v.momentum, priceChange5m: gone() },
      holder: { ...v.holder, holders: gone() },
    });
    expect(result.weightCoverage).toBeLessThan(MIN_WEIGHT_COVERAGE);
    expect(result.finalScore).toBeNull();
  });

  it("normiert auf das abgedeckte Gewicht", () => {
    // Fehlende Teilscores duerfen den Endscore weder automatisch senken noch heben.
    const v = healthyToken();
    const withPending = computeScores({
      ...v,
      pending: {
        smartMoneyBuyers: val(4),
        smartMoneySellers: val(0),
        socialAuthenticity: val(80),
        socialMomentum: val(80),
        devScore: val(80),
        narrativeScore: val(80),
      },
    });
    expect(withPending.weightCoverage).toBeCloseTo(1, 9);
    expect(withPending.notComputable).toEqual([]);
  });

  it("meldet nicht berechenbare Teilscores namentlich", () => {
    const result = computeScores(healthyToken());
    expect([...result.notComputable].sort()).toEqual([
      "dev",
      "narrative",
      "smartMoney",
      "social",
    ]);
  });

  it("sammelt Begruendungen fuer den Score", () => {
    const v = healthyToken();
    const result = computeScores({
      ...v,
      security: { ...v.security, top10HolderSharePct: val(52) },
    });
    expect(result.drivers.map((d) => d.code)).toContain("HOLDER_CONCENTRATION");
  });

  it("laesst einen CRITICAL-Befund im Endscore durchschlagen", () => {
    const v = healthyToken();
    const result = computeScores({
      ...v,
      security: { ...v.security, riskLevel: val("CRITICAL" as const) },
    });
    // Der Score sinkt — aber er ist NICHT die Schutzschicht. Das Hard Gate ist es.
    expect(result.finalScore).toBeLessThan(computeScores(v).finalScore!);
  });

  /**
   * Die Trennung der beiden Fragen (§121).
   *
   * `healthyToken()` hat alles, was dieses System erhebt — und nichts von dem,
   * was es noch nicht erhebt. Genau daran zeigt sich, ob die Kennzahlen
   * auseinandergehalten werden:
   *
   * - `dataCompleteness` beantwortet „wie gut kennen wir DIESEN Token?" und
   *   ist damit 1. Vorher stand hier `< 1`, und der Abzug kam ausschliesslich
   *   aus `pending` — also aus Quellen, die es nicht gibt. Jeder Token bekam
   *   denselben Abzug, unabhaengig von seinen Daten.
   * - `weightCoverage` beantwortet „wie viel von diesem SYSTEM ist gebaut?"
   *   und bleibt unter 1. Die Luecke ist also nicht verschwunden, sie steht
   *   nur am richtigen Instrument.
   * - `missingFields` bleibt vollstaendig: was fehlt, steht weiterhin
   *   namentlich da.
   */
  it("trennt die Kenntnis ueber den Token von der Reife des Systems", () => {
    const result = computeScores(healthyToken());

    expect(result.dataCompleteness).toBe(1);
    expect(result.weightCoverage).toBeLessThan(1);
    expect(result.missingFields.map((m) => m.field)).toContain("pending.devScore");
  });

  it("laesst ein fehlendes ERHEBBARES Feld weiterhin durchschlagen", () => {
    // Die Gegenprobe: die Kennzahl ist nicht stumpf geworden. Fehlt etwas,
    // das dieses System sehr wohl erhebt, sinkt sie.
    const v = healthyToken();
    const ohne = computeScores({
      ...v,
      market: { ...v.market, volume24hUsd: gone() },
    });
    expect(ohne.dataCompleteness).toBeLessThan(1);
  });

  it("ist deterministisch", () => {
    const a = computeScores(healthyToken());
    const b = computeScores(healthyToken());
    expect(a.finalScore).toBe(b.finalScore);
  });
});
