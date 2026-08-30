import { describe, expect, it } from "vitest";
import {
  executionScore,
  holderScore,
  liquidityScore,
  momentumScore,
  securityScore,
  socialScore,
} from "../v1/sub-scores";
import { isScored } from "../sub-score";
import { gone, healthyToken, val } from "./fixtures";

const scoreOf = (r: ReturnType<typeof securityScore>): number => {
  if (!isScored(r)) throw new Error("erwartet einen berechneten Teilscore");
  return r.score;
};

describe("securityScore", () => {
  it("bewertet einen sauberen Token hoch", () => {
    expect(scoreOf(securityScore(healthyToken()))).toBeGreaterThan(80);
  });

  it("deckelt bei aktiver Mint-Authority hart", () => {
    // Eine gute Holder-Verteilung darf beliebige Nachpraegung nicht ausgleichen.
    const v = healthyToken();
    const result = securityScore({
      ...v,
      security: { ...v.security, mintAuthorityActive: val(true) },
    });
    expect(scoreOf(result)).toBeLessThanOrEqual(10);
  });

  it("deckelt bei aktiver Freeze-Authority hart", () => {
    const v = healthyToken();
    const result = securityScore({
      ...v,
      security: { ...v.security, freezeAuthorityActive: val(true) },
    });
    expect(scoreOf(result)).toBeLessThanOrEqual(10);
  });

  it("setzt CRITICAL auf null", () => {
    const v = healthyToken();
    const result = securityScore({
      ...v,
      security: { ...v.security, riskLevel: val("CRITICAL" as const) },
    });
    expect(scoreOf(result)).toBe(0);
  });

  it("straft ungesperrte Liquiditaet deutlich ab", () => {
    const v = healthyToken();
    const result = securityScore({
      ...v,
      security: { ...v.security, lpBurnedOrLocked: val(false) },
    });
    expect(scoreOf(result)).toBeLessThanOrEqual(35);
  });

  it("ist ohne die Kernmerkmale nicht berechenbar", () => {
    // Ausdruecklich kein vorsichtiger Ersatzwert: ohne Mint-Authority-Info gibt
    // es keine Sicherheitsaussage, auch keine konservative.
    const v = healthyToken();
    const result = securityScore({
      ...v,
      security: { ...v.security, mintAuthorityActive: gone() },
    });
    expect(result.kind).toBe("NOT_COMPUTABLE");
  });
});

describe("liquidityScore", () => {
  it("deckelt bei duenner Ausstiegsfaehigkeit", () => {
    const v = healthyToken();
    const result = liquidityScore({
      ...v,
      execution: { ...v.execution, exitCapacityRatio: val(1.2) },
    });
    // Ein tiefer Pool nuetzt nichts, wenn die Position nicht wieder herausgeht.
    expect(scoreOf(result)).toBeLessThan(20);
  });

  it("deckelt, wenn die Ausstiegsfaehigkeit unbekannt ist", () => {
    const v = healthyToken();
    const result = liquidityScore({
      ...v,
      execution: { ...v.execution, exitCapacityRatio: gone() },
    });
    expect(scoreOf(result)).toBeLessThanOrEqual(60);
  });
});

describe("momentumScore", () => {
  it("bewertet Beschleunigung hoeher als einen blossen Preissprung", () => {
    const v = healthyToken();
    const withVolume = momentumScore(v);
    const withoutVolume = momentumScore({
      ...v,
      momentum: { ...v.momentum, volumeAcceleration: val(0.9) },
    });
    expect(scoreOf(withVolume)).toBeGreaterThan(scoreOf(withoutVolume) + 20);
  });

  it("straft Verkaufsdruck ab", () => {
    const v = healthyToken();
    const result = momentumScore({
      ...v,
      momentum: { ...v.momentum, buys5m: val(40), sells5m: val(200) },
    });
    expect(scoreOf(result)).toBeLessThan(scoreOf(momentumScore(v)));
  });
});

describe("holderScore", () => {
  it("rechnet mit der cluster-bereinigten Zahl", () => {
    const v = healthyToken();
    const clustered = holderScore({
      ...v,
      holder: { ...v.holder, holders: val(900), distinctActors: val(90) },
    });
    // 900 Wallets, aber nur 90 Akteure: das ist eine Inszenierung, keine Nachfrage.
    expect(scoreOf(clustered)).toBeLessThan(scoreOf(holderScore(v)));
  });

  it("deckelt bei dominantem Cluster", () => {
    const v = healthyToken();
    const result = holderScore({
      ...v,
      holder: { ...v.holder, largestClusterSharePct: val(55) },
    });
    expect(scoreOf(result)).toBeLessThan(30);
  });
});

describe("executionScore", () => {
  it("faellt mit steigenden Kosten", () => {
    const v = healthyToken();
    const cheap = executionScore({ ...v, execution: { ...v.execution, expectedCostBps: val(60) } });
    const expensive = executionScore({
      ...v,
      execution: { ...v.execution, expectedCostBps: val(500) },
    });
    expect(scoreOf(cheap)).toBeGreaterThan(scoreOf(expensive));
  });
});

describe("socialScore", () => {
  it("laesst Reichweite ohne Echtheit nicht durch", () => {
    // 20.000 gekaufte Follower sind kein Signal.
    const v = healthyToken();
    const result = socialScore({
      ...v,
      pending: { ...v.pending, socialMomentum: val(95), socialAuthenticity: val(15) },
    });
    expect(scoreOf(result)).toBe(15);
  });
});
