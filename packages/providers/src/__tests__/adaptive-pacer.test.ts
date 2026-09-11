import { FixedClock } from "@sae/core";
import { describe, expect, it } from "vitest";

import { AdaptivePacer } from "../adaptive-pacer";

/**
 * Ein Takt, der sich selbst einstellt.
 *
 * Der Anlass steht im Betriebslog: ungebremst gingen 21 von 25 Anfragen
 * verloren, mit einer festen Anfrage je Sekunde immer noch 5 von 10. Die
 * Grenze des Anbieters steht nirgends — also wird sie gesucht statt geraten.
 */

const T0 = new Date("2026-09-11T12:00:00Z");

function pacer(over: Partial<ConstructorParameters<typeof AdaptivePacer>[0]> = {}): {
  readonly p: AdaptivePacer;
  readonly clock: FixedClock;
} {
  const clock = new FixedClock(T0);
  return {
    clock,
    p: new AdaptivePacer({
      clock,
      startIntervalMs: 2_000,
      minIntervalMs: 1_000,
      maxIntervalMs: 4_000,
      ...over,
    }),
  };
}

describe("Abstand halten", () => {
  it("laesst die erste Anfrage sofort durch", () => {
    // Ein Lauf mit einer einzigen Anfrage soll nicht zwei Sekunden kosten.
    expect(pacer().p.waitMs()).toBe(0);
  });

  it("wartet vor der zweiten", () => {
    const { p } = pacer();
    p.waitMs();
    expect(p.waitMs()).toBe(2_000);
  });

  it("zaehlt vergangene Zeit an", () => {
    // Dauert der Abruf selbst schon eine Sekunde, bleibt nur eine zu warten.
    const { p, clock } = pacer();
    p.waitMs();
    clock.advance(1_000);
    expect(p.waitMs()).toBe(1_000);
  });

  it("wartet gar nicht, wenn genug Zeit vergangen ist", () => {
    const { p, clock } = pacer();
    p.waitMs();
    clock.advance(10_000);
    expect(p.waitMs()).toBe(0);
  });

  /**
   * Der Fehler, der beinahe passiert waere: ein `waitMs`, das den Zeitpunkt
   * nicht setzt, saehe in einer Schleife bei jedem Aufruf denselben freien
   * Zeitpunkt — und die Bremse waere wirkungslos, ohne dass es auffiele.
   */
  it("wirkt auch, wenn in einer Schleife gefragt wird", () => {
    const { p } = pacer();
    const wartezeiten = [p.waitMs(), p.waitMs(), p.waitMs()];
    // Ohne fortgeschriebenen Zeitpunkt waere das [0, 0, 0].
    expect(wartezeiten).toEqual([0, 2_000, 4_000]);
  });
});

describe("Sich einstellen", () => {
  it("wird bei einer Abweisung sofort deutlich langsamer", () => {
    // Wer gedrosselt wird, hat schon zu viel geschickt. Vorsichtig
    // heranzutasten hiesse, weiter zu verlieren.
    const { p } = pacer();
    p.onRateLimited();
    expect(p.intervalMs).toBe(3_000);
    p.onRateLimited();
    expect(p.intervalMs).toBe(4_000);
  });

  it("geht nicht ueber die Decke", () => {
    // Ohne harte Decke koennte eine anhaltende Stoerung den Auftrag ueber
    // sein Zeitfenster ziehen — dann liegt die Queue brach, nicht der
    // Anbieter.
    const { p } = pacer();
    for (let i = 0; i < 20; i += 1) p.onRateLimited();
    expect(p.intervalMs).toBe(4_000);
  });

  it("beschleunigt erst nach einer Reihe von Erfolgen", () => {
    const { p } = pacer();
    for (let i = 0; i < 4; i += 1) p.onSuccess();
    // Vier reichen nicht.
    expect(p.intervalMs).toBe(2_000);
    p.onSuccess();
    expect(p.intervalMs).toBe(1_750);
  });

  it("geht nicht unter den Boden", () => {
    const { p } = pacer();
    for (let i = 0; i < 100; i += 1) p.onSuccess();
    expect(p.intervalMs).toBe(1_000);
  });

  it("setzt die Erfolgsreihe bei einer Abweisung zurueck", () => {
    // Sonst wuerde ein einzelner Erfolg nach vier alten die Bremse loesen,
    // obwohl gerade gedrosselt wurde.
    const { p } = pacer();
    for (let i = 0; i < 4; i += 1) p.onSuccess();
    p.onRateLimited();
    p.onSuccess();
    // Nur die Abweisung hat gewirkt, nicht der fuenfte Erfolg.
    expect(p.intervalMs).toBe(3_000);
  });

  it("pendelt sich unter anhaltender Drosselung ein und kommt zurueck", () => {
    // Der eigentliche Zweck: erst zurueck, dann wieder vor — ohne dass
    // jemand eine Zahl raten muss.
    const { p } = pacer();
    p.onRateLimited();
    p.onRateLimited();
    expect(p.intervalMs).toBe(4_000);

    for (let i = 0; i < 25; i += 1) p.onSuccess();
    expect(p.intervalMs).toBeLessThan(4_000);
    expect(p.intervalMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe("Unsinnige Grenzen", () => {
  it("weist einen Boden von null zurueck", () => {
    expect(() => pacer({ minIntervalMs: 0 })).toThrow(RangeError);
  });

  it("weist eine Decke unter dem Boden zurueck", () => {
    expect(() => pacer({ minIntervalMs: 5_000, maxIntervalMs: 1_000 })).toThrow(RangeError);
  });

  it("zwingt einen Startwert zwischen die Grenzen", () => {
    expect(pacer({ startIntervalMs: 99_000 }).p.intervalMs).toBe(4_000);
    expect(pacer({ startIntervalMs: 1 }).p.intervalMs).toBe(1_000);
  });
});
