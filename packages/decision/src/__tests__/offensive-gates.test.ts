import { describe, expect, it } from "vitest";
import { computeScores } from "@sae/scoring";
import type { FeatureVector } from "@sae/scoring";
import { PAPER_STRATEGY_ID, paperCandidate } from "@sae/config";

import { evaluateHardGates, type GateContext } from "../hard-gates";
import { goodFeatures, gone, val } from "./fixtures";

/**
 * Was der Offensiv-Modus oeffnet und was nicht.
 *
 * Der Modus hatte bis hierher keinen einzigen Test, und er ist der, in dem der
 * Betreiber faehrt. Genau an ihm wurde die teuerste Verwechslung dieses
 * Projekts gemacht: „warte nicht auf Daten, die FEHLEN" wurde im Profil zu
 * „ignoriere Daten, die DA SIND".
 *
 * Die Trennlinie, die diese Tests festnageln:
 *
 * - Eine WISSENSLUECKE darf der Offensiv-Modus uebergehen. Darum geht es.
 * - Ein BEFUND darf er nicht uebergehen. Eine gemessene Falle offensiv zu
 *   betreten bringt keinen Trade, den man haben will.
 */

const SCHWELLE = 10;

function ctx(features: FeatureVector, mode: "VORSICHTIG" | "OFFENSIV"): GateContext {
  const kandidat = paperCandidate(SCHWELLE, mode);
  return {
    features,
    scoring: computeScores(features),
    parameters: kandidat.parameters,
    criticalProvidersUnavailable: [],
    tokenBlacklisted: false,
    hasOpenIntentOnMint: false,
  };
}

const gruende = (features: FeatureVector, mode: "VORSICHTIG" | "OFFENSIV"): readonly string[] =>
  evaluateHardGates(ctx(features, mode)).failures;

it("faehrt unter derselben Strategie-Kennung, damit die Auswertung trennbar bleibt", () => {
  expect(paperCandidate(SCHWELLE, "OFFENSIV").strategyId).toBe(PAPER_STRATEGY_ID);
  // Die Version traegt den Modus: eine Papier-Statistik, die vorsichtige und
  // offensive Einstiege vermengt, beantwortet keine Frage.
  expect(paperCandidate(SCHWELLE, "OFFENSIV").version).toContain("offensiv");
  expect(paperCandidate(SCHWELLE, "VORSICHTIG").version).not.toContain("offensiv");
});

describe("Ausstiegsfaehigkeit", () => {
  it("uebergeht die FEHLENDE Messung — das ist der Zweck des Modus", () => {
    const ohne = goodFeatures({
      execution: { ...goodFeatures().execution, exitCapacityRatio: gone() },
    });
    expect(gruende(ohne, "VORSICHTIG")).toContain("DATA_INCOMPLETE");
    expect(gruende(ohne, "OFFENSIV")).not.toContain("DATA_INCOMPLETE");
  });

  it("haelt die GEMESSENE Falle auch offensiv auf", () => {
    // Faktor 0.2: die Position kommt nicht wieder heraus. Vorher entfiel
    // dieses Tor offensiv ganz, auch mit dieser Messung auf dem Tisch.
    const falle = goodFeatures({
      execution: { ...goodFeatures().execution, exitCapacityRatio: val(0.2) },
    });
    expect(gruende(falle, "OFFENSIV")).toContain("EXIT_CAPACITY_INSUFFICIENT");
    expect(gruende(falle, "VORSICHTIG")).toContain("EXIT_CAPACITY_INSUFFICIENT");
  });
});

describe("Liquiditaet", () => {
  it("uebergeht die fehlende Angabe, nicht die gemessene Unterschreitung", () => {
    const ohne = goodFeatures({
      market: { ...goodFeatures().market, liquidityUsd: gone() },
    });
    expect(gruende(ohne, "OFFENSIV")).not.toContain("DATA_INCOMPLETE");

    // Offensiv liegt die Grenze bei 1 USD — praktisch offen, aber nicht
    // abgeschafft. 0 USD Liquiditaet ist kein Markt.
    const leer = goodFeatures({
      market: { ...goodFeatures().market, liquidityUsd: val(0) },
    });
    expect(gruende(leer, "OFFENSIV")).toContain("LIQUIDITY_TOO_LOW");
  });
});

describe("Halterkonzentration", () => {
  it("laesst offensiv viel durch, aber nicht das Extrem", () => {
    const hoch = (pct: number): FeatureVector =>
      goodFeatures({ security: { ...goodFeatures().security, top10HolderSharePct: val(pct) } });

    // 70 % ist offensiv in Ordnung und vorsichtig nicht — genau die
    // Lockerung, um die es geht.
    expect(gruende(hoch(70), "OFFENSIV")).not.toContain("HOLDER_CONCENTRATION_TOO_HIGH");
    expect(gruende(hoch(70), "VORSICHTIG")).toContain("HOLDER_CONCENTRATION_TOO_HIGH");

    // 95 % ist die Signatur eines Rugs. Eine Grenze von 100 % haette das
    // durchgelassen — das war keine Lockerung, sondern die Abschaffung des
    // Tors.
    expect(gruende(hoch(95), "OFFENSIV")).toContain("HOLDER_CONCENTRATION_TOO_HIGH");
  });

  it("uebergeht die fehlende Messung in beiden Modi", () => {
    const ohne = goodFeatures({
      security: { ...goodFeatures().security, top10HolderSharePct: gone() },
    });
    expect(gruende(ohne, "OFFENSIV")).not.toContain("HOLDER_CONCENTRATION_TOO_HIGH");
    expect(gruende(ohne, "VORSICHTIG")).not.toContain("HOLDER_CONCENTRATION_TOO_HIGH");
  });
});

describe("Die Befunde, die kein Modus oeffnet", () => {
  const befunde: readonly (readonly [string, Partial<FeatureVector["security"]>, string])[] = [
    ["Mint-Autoritaet", { mintAuthorityActive: val(true) }, "MINT_AUTHORITY_ACTIVE"],
    ["Freeze-Autoritaet", { freezeAuthorityActive: val(true) }, "FREEZE_AUTHORITY_ACTIVE"],
    ["LP nicht gesperrt", { lpBurnedOrLocked: val(false) }, "LIQUIDITY_NOT_LOCKED"],
    ["Risikostufe CRITICAL", { riskLevel: val("CRITICAL" as const) }, "SECURITY_CRITICAL"],
  ];

  for (const [name, override, grund] of befunde) {
    it(`${name} blockiert in beiden Modi`, () => {
      const schlecht = goodFeatures({
        security: { ...goodFeatures().security, ...override },
      });
      expect(gruende(schlecht, "OFFENSIV")).toContain(grund);
      expect(gruende(schlecht, "VORSICHTIG")).toContain(grund);
    });
  }

  it("laesst ein Token ohne jeden Sicherheitsbefund offensiv durch", () => {
    // Keine Messung ist keine Unbedenklichkeit — aber auch kein Befund. Dass
    // der Modus hier durchlaesst, ist seine ganze Berechtigung.
    const blind = goodFeatures({
      security: {
        mintAuthorityActive: gone(), freezeAuthorityActive: gone(),
        lpBurnedOrLocked: gone(), top10HolderSharePct: gone(),
        topHolderSharePct: gone(), riskLevel: gone(),
      },
    });
    expect(evaluateHardGates(ctx(blind, "OFFENSIV")).passed).toBe(true);
    expect(evaluateHardGates(ctx(blind, "VORSICHTIG")).passed).toBe(false);
  });
});

describe("Die Groesse", () => {
  it("bleibt in beiden Modi dieselbe Zahl aus den Einstellungen", () => {
    const gross = goodFeatures({
      market: { ...goodFeatures().market, marketCapUsd: val(900_000_000) },
    });
    for (const mode of ["VORSICHTIG", "OFFENSIV"] as const) {
      expect(gruende(gross, mode)).toContain("FINAL_SCORE_TOO_LOW");
    }

    // Und sie folgt der Einstellung, statt im Code zu stehen.
    const kandidat = paperCandidate(SCHWELLE, "OFFENSIV", { maxMarketCapUsd: 1_000_000_000 });
    const offen = evaluateHardGates({
      features: gross, scoring: computeScores(gross), parameters: kandidat.parameters,
      criticalProvidersUnavailable: [], tokenBlacklisted: false, hasOpenIntentOnMint: false,
    });
    expect(offen.failures).not.toContain("FINAL_SCORE_TOO_LOW");
  });
});
