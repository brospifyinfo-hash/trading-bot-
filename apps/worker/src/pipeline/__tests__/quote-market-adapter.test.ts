import { describe, expect, it } from "vitest";
import { sourced } from "@sae/providers";
import { snapshotSupportsEntry } from "@sae/pipeline";
import type { Clock } from "@sae/core";

import { quoteMarketAdapter, QUOTE_PROVIDER_ID, type QuoteMarketDeps } from "../quote-market-adapter";

/**
 * Der Anbieter, der einen Preis MIT Zeitstempel liefert.
 *
 * Geprueft wird der ganze Weg ohne Netz: Quote, Slot, Uhrzeit, Preis, Alter,
 * und am Ende derselbe Torwaechter, der DexScreener-Daten ablehnt. Die Abrufe
 * sind eingespeist — was hier geprueft wird, ist unsere Rechnung und unsere
 * Verkettung, nicht das Verhalten eines Anbieters.
 */

const T0 = new Date("2026-09-07T12:00:00Z");
const clock: Clock = { now: () => T0 };
const MEME = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function deps(over: Partial<QuoteMarketDeps> = {}): QuoteMarketDeps {
  return {
    clock,
    quoteMint: USDC,
    // 100 USDC — die Summe, fuer die gefragt wird, auf der ANKER-Seite.
    probeNotional: 100,
    // Ausstieg wird beim Fuenffachen der Position gefragt, gegen 200 bp.
    exitProbe: { multiple: 5, maxImpactBps: 200 },
    decimalsOf: async () => 6,
    // Dafuer gibt es 25 Token (6 Stellen). Preis von Hand: 100 / 25 = 4,00.
    fetchQuote: async () => ({ kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000 , priceImpactBps: 120}),
    fetchSlotTime: async () => new Date(T0.getTime() - 2_000),
    ...over,
  };
}

describe("Preis mit Zeitstempel", () => {
  it("fuellt observedAt mit der Zeit des ANBIETERS", async () => {
    const result = await quoteMarketAdapter(deps()).fetchMarket(MEME);
    expect(result).not.toBeNull();
    if (result === null) return;

    // 100 USDC -> 25 Token. Ein Token kostet also 4,00.
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
    // Nicht unsere Abrufzeit, sondern die Rechenzeit des Anbieters.
    expect(result.observedAt).toEqual(new Date(T0.getTime() - 2_000));
  });

  it("ergibt ueber sourced() ein echtes Datenalter", async () => {
    // Der Punkt der ganzen Kette: hier entsteht die Zahl, die bisher immer
    // `null` war und einmal faelschlich 0 (DECISIONS §89).
    const result = await quoteMarketAdapter(deps()).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");

    const s = sourced({
      value: result.value,
      providerId: QUOTE_PROVIDER_ID,
      tier: "PRIMARY",
      providerObservedAt: result.observedAt,
      fetchedAt: T0,
    });
    expect(s.freshnessSeconds).toBe(2);

    expect(
      snapshotSupportsEntry({
        providerId: QUOTE_PROVIDER_ID,
        tier: "PRIMARY",
        freshnessSeconds: s.freshnessSeconds,
        contributors: [],
      }).allowed,
    ).toBe(true);
  });

  it("liefert nichts ohne Dezimalstellen", async () => {
    // Geratene Dezimalstellen waeren ein Betragsfehler um Zehnerpotenzen —
    // der teuerste denkbare Fehler in dieser Rechnung.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({ decimalsOf: async () => null, onUnusable: (_m, r) => gruende.push(r) }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_DECIMALS"]);
  });

  /**
   * Der Anker ist nicht lesbar — ein anderer Befund als „dieser Token ist
   * nicht lesbar", weil er JEDEN Token betrifft. Im Log ist der Unterschied
   * die Antwort auf die Frage, ob ein Token oder die Quelle das Problem ist.
   */
  it("unterscheidet einen unlesbaren Anker von einem unlesbaren Token", async () => {
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        decimalsOf: async (m) => (m === USDC ? null : 6),
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_ANCHOR_DECIMALS"]);
  });

  /**
   * Die Probemenge wird aus den GELESENEN Ankerstellen gerechnet, nicht aus
   * einer Konstante. Ein Anker mit neun Stellen muss deshalb auch eine
   * neunstellige Rohmenge ergeben — sonst waere die Anfrage um Faktor 1000 zu
   * klein und der Preis stammte aus einem Staubauftrag.
   */
  it("rechnet die Probemenge aus den gelesenen Ankerstellen", async () => {
    const gefragt: bigint[] = [];
    await quoteMarketAdapter(
      deps({
        decimalsOf: async (m) => (m === USDC ? 9 : 6),
        fetchQuote: async (input) => {
          gefragt.push(input.amountRaw);
          return { kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000 , priceImpactBps: 120};
        },
      }),
    ).fetchMarket(MEME);
    // Die Kaufmenge folgt den ANKERstellen (hier neun), die Verkaufsmenge dem
    // gemessenen Gegenwert. Dass beide verschiedenen Groessen folgen, ist der
    // Punkt: eine gemeinsame Konstante waere bei jedem Dezimalstellen-Paar
    // still um Zehnerpotenzen daneben.
    expect(gefragt).toEqual([100_000_000_000n, 125_000_000n]);
  });

  it("fragt gar nicht erst mit einer unsinnigen Probemenge", async () => {
    const gruende: string[] = [];
    let gefragt = 0;
    const result = await quoteMarketAdapter(
      deps({
        probeNotional: 0,
        fetchQuote: async () => {
          gefragt += 1;
          return { kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000 , priceImpactBps: 120};
        },
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["BAD_PROBE_SIZE"]);
    expect(gefragt).toBe(0);
  });

  it("liefert nichts, wenn der Anbieter keinen Slot nennt", async () => {
    // Genau der Fall, an dem der ganze Weg haengt. Ohne Slot kein Alter — und
    // ohne Alter wird hier nichts erfunden.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ kind: "OK", outAmountRaw: 25_000_000n, contextSlot: null , priceImpactBps: 120}),
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    expect(gruende).toEqual(["NO_CONTEXT_SLOT"]);
  });

  it("fragt die Slot-Uhrzeit gar nicht erst ohne Slot", async () => {
    let gefragt = 0;
    await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ kind: "OK", outAmountRaw: 25_000_000n, contextSlot: null , priceImpactBps: 120}),
        fetchSlotTime: async () => {
          gefragt += 1;
          return T0;
        },
      }),
    ).fetchMarket(MEME);
    // Ein Aufruf, dessen Ergebnis feststeht, kostet nur Budget.
    expect(gefragt).toBe(0);
  });

  it("reicht ergaenzende Felder durch und erfindet die fehlenden nicht", async () => {
    const result = await quoteMarketAdapter(
      deps({ companion: async () => ({ liquidityUsd: 180_000 }) }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.liquidityUsd).toBe(180_000);
    expect(result.value.volume24hUsd).toBeNull();
    expect(result.value.holders).toBeNull();
  });

  /**
   * Die Richtung ist der Fehler, der stumm bleibt.
   *
   * Ein vertauschtes Paar liefert weiterhin eine Zahl, einen Slot und ein
   * Alter — nur eben den Kehrwert des Preises. Bei einem Token zu 4,00 stuende
   * dann 0,25 im Snapshot, und nichts daran sieht kaputt aus.
   */
  it("fragt mit dem Anker und liest die Messung vom Token aus", async () => {
    const gefragt: { inputMint: string; outputMint: string; amountRaw: bigint }[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async (input) => {
          gefragt.push(input);
          return { kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000 , priceImpactBps: 120};
        },
      }),
    ).fetchMarket(MEME);

    expect(gefragt).toEqual([
      // Der Kauf: Anker hinein, Token heraus.
      { inputMint: USDC, outputMint: MEME, amountRaw: 100_000_000n },
      // Die Verkaufssonde: dieselben Mints andersherum, und die Menge ist das
      // Fuenffache dessen, was der Kauf tatsaechlich einbrachte
      // (5 × 25_000_000). Aus dem GEMESSENEN Gegenwert gerechnet und nicht aus
      // dem Preis zurueck — sonst haenge die Ausstiegsfrage an genau der Zahl,
      // die sie pruefen soll.
      { inputMint: MEME, outputMint: USDC, amountRaw: 125_000_000n },
    ]);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
    // Ausdruecklich: NICHT der Kehrwert.
    expect(result.value.priceUsd).not.toBeCloseTo(0.25, 9);
  });

  /**
   * Der Fall, den eine feste Rohmenge auf der Token-Seite falsch gemacht
   * haette: neun Dezimalstellen statt sechs. Die Anker-Seite bleibt davon
   * unberuehrt, und der Preis stimmt weiterhin.
   */
  it("rechnet auch bei neun Dezimalstellen richtig", async () => {
    const result = await quoteMarketAdapter(
      deps({
        // Nur der gesuchte Token hat neun Stellen; der Anker behaelt sechs.
        decimalsOf: async (m) => (m === USDC ? 6 : 9),
        // 100 USDC -> 25 Token, diesmal mit 9 Stellen ausgedrueckt.
        fetchQuote: async () => ({ kind: "OK", outAmountRaw: 25_000_000_000n, contextSlot: 300_000_000 , priceImpactBps: 120}),
      }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
  });

  /**
   * Der eigentliche Anwendungsfall: ein Memecoin unter einem Cent. Genau der
   * Bereich, in dem eine Ganzzahl-Division ohne Zusatzstellen glatt 0 ergaebe.
   */
  it("traegt einen Preis von Bruchteilen eines Cents", async () => {
    const result = await quoteMarketAdapter(
      deps({
        // 100 USDC -> 400 Mio Token: 0,00000025 USD je Token.
        fetchQuote: async () => ({
          kind: "OK",
          outAmountRaw: 400_000_000_000_000n,
          contextSlot: 300_000_000,
          priceImpactBps: 120,
        }),
      }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(0.00000025, 12);
  });

  it("liefert nichts, wenn der Router keinen Weg findet", async () => {
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async () => ({ kind: "NONE", reason: "QUOTE_BAD_REQUEST" }),
        onUnusable: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);
    expect(result).toBeNull();
    // Der Grund des Anbieters, unveraendert — nicht das generische NO_QUOTE,
    // das vorher jede Ursache eingeebnet hat.
    expect(gruende).toEqual(["QUOTE_BAD_REQUEST"]);
  });
});


/**
 * Die Ausstiegsfaehigkeit — das Feld, an dem bis §119 JEDER Token scheiterte.
 *
 * Sie ist ein HARTES Tor: fehlt sie, lehnt `evaluateHardGates` mit
 * `DATA_INCOMPLETE` ab, und kein Score kommt daran vorbei. Sie stand auf
 * `notCollected()`, weil der vorhandene Rechner die Pool-Reserve verlangt, die
 * keine Quelle liefert. Gemessen wird sie deshalb dort, wo sie wirklich
 * entsteht: an einer zweiten Anfrage in der Gegenrichtung.
 */
describe("Ausstiegsfaehigkeit", () => {
  /** Kauf wie im Helfer, Verkauf mit frei waehlbarem Impact. */
  function mitAusstieg(exitImpactBps: number | null, over: Partial<QuoteMarketDeps> = {}) {
    return deps({
      fetchQuote: async (input) =>
        input.inputMint === USDC
          ? { kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000, priceImpactBps: 120 }
          : { kind: "OK", outAmountRaw: 95_000_000n, contextSlot: 300_000_000, priceImpactBps: exitImpactBps },
      ...over,
    });
  }

  it("meldet nie mehr Kapazitaet, als tatsaechlich abgefragt wurde", async () => {
    // 40 bp bei fuenffacher Position, Grenze 200 bp: rechnerisch ginge weit
    // mehr. Behauptet wird trotzdem nur das, was geroutet wurde.
    const result = await quoteMarketAdapter(mitAusstieg(40)).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.exitCapacityRatio).toBe(5);
  });

  it("skaliert herunter, wenn der Ausstieg die Grenze reisst", async () => {
    // Doppelter Impact heisst grob halbe Menge — vom GEMESSENEN Punkt nach
    // unten, nicht von einer kleinen Probe nach oben hochgerechnet.
    const result = await quoteMarketAdapter(mitAusstieg(400)).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.exitCapacityRatio).toBeCloseTo(2.5, 9);
  });

  it("bleibt an der Grenze genau beim abgefragten Vielfachen", async () => {
    const result = await quoteMarketAdapter(mitAusstieg(200)).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.exitCapacityRatio).toBe(5);
  });

  it("laesst den Preis stehen, wenn nur die Sonde scheitert", async () => {
    // Der wichtigste Fall. Ein gedrosselter Verkaufsabruf ist kein Grund, eine
    // gemessene Preisbeobachtung wegzuwerfen — sonst kostet eine Nebenfrage
    // den Hauptbefund.
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      deps({
        fetchQuote: async (input) =>
          input.inputMint === USDC
            ? { kind: "OK", outAmountRaw: 25_000_000n, contextSlot: 300_000_000, priceImpactBps: 120 }
            : { kind: "NONE", reason: "QUOTE_RATE_LIMITED" },
        onExitProbe: (_m, r) => gruende.push(r),
      }),
    ).fetchMarket(MEME);

    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.priceUsd).toBeCloseTo(4, 9);
    // Nicht gemessen — und ausdruecklich nicht 0. Eine Null hier waere ein
    // Markturteil aus einem Anbieterproblem.
    expect(result.value.exitCapacityRatio).toBeNull();
    expect(gruende).toEqual(["QUOTE_RATE_LIMITED"]);
  });

  it("erfindet nichts, wenn der Router keinen Impact nennt", async () => {
    const gruende: string[] = [];
    const result = await quoteMarketAdapter(
      mitAusstieg(null, { onExitProbe: (_m: string, r: string) => gruende.push(r) }),
    ).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.exitCapacityRatio).toBeNull();
    expect(gruende).toEqual(["NO_EXIT_IMPACT"]);
  });

  it("wertet fehlenden Einfluss als volle abgefragte Kapazitaet", async () => {
    // 0 bp heisst: bei dieser Menge war nichts messbar. Das ist eine Auskunft
    // ueber den Markt und kein fehlender Wert.
    const result = await quoteMarketAdapter(mitAusstieg(0)).fetchMarket(MEME);
    if (result === null) throw new Error("erwartet: Ergebnis");
    expect(result.value.exitCapacityRatio).toBe(5);
  });
});
