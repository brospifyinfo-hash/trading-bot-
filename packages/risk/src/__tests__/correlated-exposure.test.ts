import { describe, expect, it } from "vitest";
import { eur } from "@sae/core";

import {
  DEFAULT_CORRELATION_LIMITS,
  StreamExposureBook,
  UNKNOWN_CORRELATION_GROUP,
  checkStreamExposure,
  type CorrelatedPosition,
  type StreamExposureState,
} from "../correlated-exposure";

const PORTFOLIO = eur(10_000);

function position(
  tokenId: string,
  amount: number,
  correlationGroup: string | null = null,
): CorrelatedPosition {
  return { tokenId, notional: eur(amount), correlationGroup };
}

function stream(
  s: StreamExposureState["stream"],
  positions: readonly CorrelatedPosition[],
): StreamExposureState {
  return { stream: s, value: PORTFOLIO, positions };
}

describe("Korrelationsgruppen", () => {
  it("zaehlt Positionen derselben Gruppe zusammen", () => {
    // Drei Tokens desselben Deployers sind keine drei Positionen zu je 3 %,
    // sondern eine zu 9 %.
    const state = stream("LIVE", [
      position("a", 300, "deployer-x"),
      position("b", 300, "deployer-x"),
    ]);
    const result = checkStreamExposure(state, position("c", 300, "deployer-x"));

    const group = result.groups.find((g) => g.group === "deployer-x")!;
    expect(group.exposure).toEqual(eur(900));
    expect(group.exposurePct).toBeCloseTo(9, 1);
    expect(result.violations).toContain("CORRELATION_GROUP_EXPOSURE_LIMIT");
    expect(result.violations).toContain("CORRELATION_GROUP_POSITION_LIMIT");
  });

  it("laesst verschiedene Gruppen nebeneinander laufen", () => {
    const state = stream("LIVE", [
      position("a", 300, "deployer-x"),
      position("b", 300, "narrative-y"),
    ]);
    const result = checkStreamExposure(state, position("c", 300, "narrative-z"));
    expect(result.withinLimits).toBe(true);
    expect(result.groups).toHaveLength(3);
  });

  it("behandelt unbekannte Zuordnung als korreliert, nicht als unabhaengig", () => {
    // Sonst waere fehlende Information die bequemste Art, jedes
    // Konzentrationslimit zu umgehen — genau solange, wie die
    // Clustering-Daten fehlen.
    const state = stream("LIVE", [position("a", 400, null), position("b", 400, null)]);
    const result = checkStreamExposure(state, position("c", 400, null));

    const unknown = result.groups.find((g) => g.group === UNKNOWN_CORRELATION_GROUP)!;
    expect(unknown.isUnknownBucket).toBe(true);
    expect(unknown.positionCount).toBe(3);
    expect(result.violations).toContain("CORRELATION_GROUP_EXPOSURE_LIMIT");
  });

  it("verhindert dieselbe Position zweimal im selben Strom", () => {
    const state = stream("AUTO_PAPER", [position("a", 100, "g")]);
    const result = checkStreamExposure(state, position("a", 100, "g"));
    expect(result.violations).toContain("TOKEN_ALREADY_HELD_IN_STREAM");
  });
});

describe("Getrennte Buecher je Strom", () => {
  it("laesst ein volles Paper-Buch den Live-Handel nicht blockieren", () => {
    // I-10: zusammengezaehlt blockiert simuliertes Kapital echte Trades,
    // obwohl dort kein einziger Euro liegt.
    const book = new StreamExposureBook();
    book.set(
      stream(
        "AUTO_PAPER",
        Array.from({ length: DEFAULT_CORRELATION_LIMITS.maxOpenPositions }, (_, i) =>
          position(`paper-${i}`, 500, `g-${i}`),
        ),
      ),
    );
    book.set(stream("LIVE", []));

    expect(book.check("AUTO_PAPER", position("neu", 500, "g-neu"))!.violations).toContain(
      "MAX_OPEN_POSITIONS_REACHED",
    );
    expect(book.check("LIVE", position("neu", 500, "g-neu"))!.withinLimits).toBe(true);
  });

  it("sieht denselben Token in zwei Stroemen nicht als doppelte Position", () => {
    const book = new StreamExposureBook();
    book.set(stream("MANUAL_PAPER", [position("token-a", 300, "g")]));
    book.set(stream("LIVE", []));

    // Derselbe Token, anderer Strom: kein Konflikt. Im selben Strom schon.
    expect(book.check("LIVE", position("token-a", 300, "g"))!.withinLimits).toBe(true);
    expect(
      book.check("MANUAL_PAPER", position("token-a", 300, "g"))!.violations,
    ).toContain("TOKEN_ALREADY_HELD_IN_STREAM");
  });

  it("bietet keine Gesamtsumme ueber die Stroeme an", () => {
    const book = new StreamExposureBook();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(book));
    // Eine solche Zahl waere sofort in einem Gate gelandet.
    expect(methods).not.toContain("totalExposure");
    expect(methods).not.toContain("combined");
    expect(methods.sort()).toEqual(["check", "constructor", "get", "set", "streams"]);
  });

  it("erlaubt nichts, wenn der Strom unbekannt ist", () => {
    const book = new StreamExposureBook();
    // „Kein Buch" heisst nicht „dann eben erlaubt".
    expect(book.check("LIVE", position("a", 100, "g"))).toBeNull();
  });
});

describe("Waehrungen", () => {
  it("weist eine Position in anderer Waehrung zurueck", () => {
    const state = stream("LIVE", []);
    expect(() =>
      checkStreamExposure(state, {
        tokenId: "a",
        notional: { minor: 10_000n, currency: "USD" },
        correlationGroup: null,
      }),
    ).toThrow(/Waehrung/);
  });
});
