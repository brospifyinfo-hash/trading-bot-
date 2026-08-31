import { describe, expect, it } from "vitest";

import {
  runShadowComparison,
  type ShadowOpportunity,
  type ShadowStrategy,
} from "../shadow";

interface Features {
  readonly score: number;
  readonly liquidity: number;
}

const byScore = (min: number): ShadowStrategy<Features> => ({
  id: `score>=${min}`,
  decide: (f) => (f.score >= min ? "ENTER" : "SKIP"),
});

let counter = 0;
function opportunity(
  score: number,
  hypotheticalReturn: number | null,
  liquidity = 100_000,
): ShadowOpportunity<Features> {
  counter += 1;
  return {
    opportunityId: `opp-${counter}`,
    decidedAt: new Date(Date.UTC(2026, 7, 1) + counter * 60_000),
    features: { score, liquidity },
    hypotheticalReturn,
  };
}

/** n Gelegenheiten in einem Score-Band mit fester Trefferquote. */
function band(n: number, score: number, winRate: number): ShadowOpportunity<Features>[] {
  const wins = Math.round(n * winRate);
  return Array.from({ length: n }, (_, i) => opportunity(score, i < wins ? 0.5 : -0.2));
}

describe("Shadow Trading", () => {
  it("reicht beiden Strategien dasselbe Feature-Objekt", () => {
    // Zwei getrennt geladene Vektoren koennten verschiedene Datenstaende sein —
    // und der Challenger koennte den neueren erwischen.
    const seenByChampion: Features[] = [];
    const seenByChallenger: Features[] = [];
    const opportunities = [opportunity(80, 0.4), opportunity(60, -0.1)];

    runShadowComparison({
      champion: {
        id: "champ",
        decide: (f) => {
          seenByChampion.push(f);
          return "ENTER";
        },
      },
      challenger: {
        id: "chall",
        decide: (f) => {
          seenByChallenger.push(f);
          return "SKIP";
        },
      },
      opportunities,
    });

    expect(seenByChampion[0]).toBe(opportunities[0]!.features);
    expect(seenByChallenger[0]).toBe(opportunities[0]!.features);
    expect(seenByChampion[1]).toBe(seenByChallenger[1]);
  });

  it("zaehlt die vier Uebereinstimmungsfaelle getrennt", () => {
    const result = runShadowComparison({
      champion: byScore(70),
      challenger: byScore(60),
      opportunities: [
        opportunity(80, 0.3),
        opportunity(65, 0.2),
        opportunity(50, -0.1),
        opportunity(90, 0.4),
      ],
    });

    expect(result.counts.BOTH_ENTER).toBe(2);
    expect(result.counts.CHALLENGER_ONLY).toBe(1);
    expect(result.counts.CHAMPION_ONLY).toBe(0);
    expect(result.counts.BOTH_SKIP).toBe(1);
  });

  it("urteilt nur ueber die Abweichungen", () => {
    // 400 uebereinstimmende Gelegenheiten mit hoher Trefferquote und 200
    // Abweichungen mit schlechter: das Urteil darf sich nicht von den
    // uebereinstimmenden Faellen beeindrucken lassen.
    const result = runShadowComparison({
      champion: byScore(70),
      challenger: byScore(50),
      opportunities: [
        ...band(400, 80, 0.9), // beide steigen ein
        ...band(200, 55, 0.1), // nur der Challenger
        ...band(200, 40, 0.6).map((o) => ({ ...o, features: { ...o.features, score: 40 } })),
      ],
    });

    expect(result.counts.BOTH_ENTER).toBe(400);
    expect(result.counts.CHALLENGER_ONLY).toBe(200);
    // Nur-Champion-Faelle gibt es hier nicht, also kein Urteil.
    expect(result.verdict).toBe("TOO_LITTLE_DATA");
    expect(result.note).toMatch(/aufgeloeste Abweichungen/);
  });

  it("nennt ueberlappende Intervalle keinen Unterschied", () => {
    const opportunities = [
      ...band(300, 80, 0.42), // nur Champion (Challenger verlangt Liquiditaet)
      ...band(300, 60, 0.40), // nur Challenger
    ];
    const result = runShadowComparison({
      champion: { id: "champ", decide: (f) => (f.score >= 70 ? "ENTER" : "SKIP") },
      challenger: { id: "chall", decide: (f) => (f.score < 70 ? "ENTER" : "SKIP") },
      opportunities,
    });

    expect(result.counts.CHAMPION_ONLY).toBe(300);
    expect(result.counts.CHALLENGER_ONLY).toBe(300);
    expect(result.verdict).toBe("NO_DIFFERENCE");
    expect(result.note).toMatch(/nicht besser, sondern nur anders/);
  });

  it("erkennt einen belegt besseren Herausforderer", () => {
    const opportunities = [
      ...band(300, 80, 0.25), // nur Champion
      ...band(300, 60, 0.65), // nur Challenger
    ];
    const result = runShadowComparison({
      champion: { id: "champ", decide: (f) => (f.score >= 70 ? "ENTER" : "SKIP") },
      challenger: { id: "chall", decide: (f) => (f.score < 70 ? "ENTER" : "SKIP") },
      opportunities,
    });

    expect(result.verdict).toBe("CHALLENGER_BETTER");
    expect(result.note).toMatch(/sagen zum Unterschied nichts/);
  });

  it("zaehlt offene Gelegenheiten nicht als Null", () => {
    const result = runShadowComparison({
      champion: { id: "champ", decide: () => "ENTER" },
      challenger: { id: "chall", decide: () => "SKIP" },
      opportunities: [opportunity(80, null), opportunity(80, 0.4), opportunity(80, null)],
    });

    expect(result.championOnly.count).toBe(3);
    expect(result.championOnly.resolvedCount).toBe(1);
    expect(result.championOnly.winRate).toBe(1);
  });
});
