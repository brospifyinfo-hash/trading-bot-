import { describe, expect, it } from "vitest";
import { DEFAULT_STRATEGY_PARAMETERS } from "@sae/config";
import { cheapScreen, type CheapScreenInput } from "../cheap-screen";
import { T0, discovered, gone, val } from "./fixtures";

const input = (overrides: Partial<CheapScreenInput> = {}): CheapScreenInput => ({
  token: discovered(),
  mintAuthorityActive: val(false),
  freezeAuthorityActive: val(false),
  now: T0,
  parameters: DEFAULT_STRATEGY_PARAMETERS,
  blacklisted: false,
  ...overrides,
});

describe("cheapScreen", () => {
  it("laesst einen unauffaelligen Token durch", () => {
    const result = cheapScreen(input());
    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("siebt grober als das eigentliche Gate", () => {
    // 15.000 liegt unter dem Einstiegs-Gate von 25.000, aber ueber der halben
    // Schwelle — der Token darf weiter, weil Liquiditaet zunehmen kann.
    // Wer hier zu fein filtert, verliert Kandidaten vor der eigentlichen Analyse.
    const result = cheapScreen(input({ token: discovered({ liquidityUsd: val(15_000) }) }));
    expect(result.passed).toBe(true);
  });

  it("lehnt offensichtlich zu duenne Liquiditaet ab", () => {
    const result = cheapScreen(input({ token: discovered({ liquidityUsd: val(2_000) }) }));
    expect(result.reasons).toContain("LIQUIDITY_TOO_LOW");
  });

  it("laesst einen Token trotz duenner Liquiditaet in Beobachtung", () => {
    // Liquiditaet ist eine Momentaufnahme. Der Token ist die spaetere
    // Kontrollgruppe — ohne ihn beruht die Faktoranalyse nur auf Gehandeltem.
    const result = cheapScreen(input({ token: discovered({ liquidityUsd: val(2_000) }) }));
    expect(result.keepWatching).toBe(true);
  });

  it("schliesst eine aktive Mint-Authority endgueltig aus", () => {
    const result = cheapScreen(input({ mintAuthorityActive: val(true) }));
    expect(result.passed).toBe(false);
    expect(result.keepWatching).toBe(false);
  });

  it("schliesst eine aktive Freeze-Authority endgueltig aus", () => {
    const result = cheapScreen(input({ freezeAuthorityActive: val(true) }));
    expect(result.keepWatching).toBe(false);
  });

  it("schliesst einen bekannten Betrugs-Token endgueltig aus", () => {
    const result = cheapScreen(input({ blacklisted: true }));
    expect(result.reasons).toContain("TOKEN_BLACKLISTED");
    expect(result.keepWatching).toBe(false);
  });

  it("laesst einen Token durch, wenn die Autoritaeten unbekannt sind", () => {
    // Unbekannt ist nicht dasselbe wie aktiv. Die Frage wird in der Security-
    // Engine gegen die Chain geklaert — hier waere eine Ablehnung zu frueh.
    const result = cheapScreen(
      input({ mintAuthorityActive: gone(), freezeAuthorityActive: gone() }),
    );
    expect(result.passed).toBe(true);
  });

  it("lehnt einen zu jungen Token vorlaeufig ab", () => {
    const result = cheapScreen(
      input({ token: discovered({ launchedAt: new Date(T0.getTime() - 30_000) }) }),
    );
    expect(result.reasons).toContain("DATA_INCOMPLETE");
    expect(result.keepWatching).toBe(true);
  });

  it("misstraut einem Token aus der Zukunft", () => {
    // Eine Quelle mit falsch gestellter Uhr liefert Muell — und dem ist auch
    // sonst nicht zu trauen.
    const result = cheapScreen(
      input({ token: discovered({ launchedAt: new Date(T0.getTime() + 600_000) }) }),
    );
    expect(result.reasons).toContain("DATA_STALE");
  });

  it("lehnt einen viel zu grossen Token ab", () => {
    const result = cheapScreen(input({ token: discovered({ marketCapUsd: val(50_000_000) }) }));
    expect(result.passed).toBe(false);
  });

  it("urteilt nicht ueber fehlende Werte", () => {
    const result = cheapScreen(
      input({ token: discovered({ liquidityUsd: gone(), marketCapUsd: gone() }) }),
    );
    expect(result.passed).toBe(true);
  });
});
