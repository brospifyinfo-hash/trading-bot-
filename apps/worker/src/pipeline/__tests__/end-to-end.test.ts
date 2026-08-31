import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@sae/db";
import { bps, eur } from "@sae/core";
import { DEFAULT_FEES, DEFAULT_LATENCY } from "@sae/simulation";
import { PaperExecutor } from "@sae/trading";

import { runOpportunityPipeline, PAPER_NOTIONAL } from "../opportunity-pipeline";
import { testFixtureRequest } from "../test-fixture";
import { NoQuoteSource, createHarness, type Harness } from "./harness";

/**
 * Der ganze Weg, mit einem ausdruecklich gekennzeichneten TEST FIXTURE.
 *
 * Was dieser Test beweist: die Verarbeitung von der Eingabe bis zu zwei
 * getrennten Stroemen funktioniert technisch.
 *
 * Was er ausdruecklich NICHT beweist: dass die Strategie funktioniert, dass die
 * Zahlen realistisch sind oder dass es eine Datenquelle gibt. Alles, was hier
 * entsteht, traegt `source_type = 'TEST_FIXTURE'` und ist damit aus jeder
 * Produktionsauswertung ausgeschlossen — durchgesetzt von der Datenbank.
 */

const T0 = new Date("2026-08-31T12:00:00Z");

let h: Harness;
let db: Database;

beforeEach(async () => {
  h = await createHarness(T0);
  db = h.db;
});

afterEach(async () => {
  await h.close();
});

const request = (overrides: { asOf?: Date; label?: string } = {}) =>
  testFixtureRequest({
    tokenId: h.tokenId,
    label: overrides.label ?? "end-to-end",
    asOf: overrides.asOf ?? T0,
  });

describe("TEST_FIXTURE → Decision → Opportunity → Auto Paper + Manual", () => {
  it("erzeugt aus EINER Entscheidung beide Stroeme", async () => {
    const result = await runOpportunityPipeline(request(), h.deps());

    expect(result.kind).toBe("ENTERED");
    if (result.kind !== "ENTERED") return;

    // Genau eine Gelegenheit je Strom — und beide aus derselben Entscheidung.
    const streams = result.created.map((c) => c.stream).sort();
    expect(streams).toEqual(["AUTO_PAPER", "MANUAL_PAPER"]);
    expect(new Set(result.created.map((c) => c.snapshotId)).size).toBe(1);

    const rows = await db.select().from(schema.opportunities);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.decisionKind === "ENTER")).toBe(true);
    expect(rows.every((r) => r.strategyVersionId === h.strategyVersionId)).toBe(true);
    expect(rows.every((r) => r.decidedAt.getTime() === T0.getTime())).toBe(true);

    // Herkunft: beide als Fixture markiert, in beiden Spalten.
    expect(rows.every((r) => r.sourceType === "TEST_FIXTURE")).toBe(true);
    expect(rows.every((r) => r.isTestFixture)).toBe(true);
  });

  it("oeffnet fuer AUTO genau eine Position ueber 100 EUR", async () => {
    const result = await runOpportunityPipeline(request(), h.deps());
    if (result.kind !== "ENTERED") throw new Error(`Erwartet ENTERED, war ${result.kind}`);
    expect(result.autoPosition.kind).toBe("OPENED");

    const positions = await db.select().from(schema.paperPositions);
    expect(positions).toHaveLength(1);
    const position = positions[0]!;
    expect(position.stream).toBe("AUTO_PAPER");
    expect(position.sizingMode).toBe("FIXED_100");
    expect(position.entryNotionalMinor).toBe(PAPER_NOTIONAL.minor);
    expect(position.currency).toBe("EUR");
    expect(position.sourceType).toBe("TEST_FIXTURE");
    expect(position.isTestFixture).toBe(true);

    // Die Position haengt an der AUTO-Gelegenheit, nicht an der Manual.
    const auto = result.created.find((c) => c.stream === "AUTO_PAPER")!;
    expect(position.opportunityId).toBe(auto.opportunityId);

    // Und es gibt ein Eroeffnungsereignis.
    const events = await db.select().from(schema.paperPositionEvents);
    expect(events.map((e) => e.kind)).toContain("OPENED");
  });

  it("bucht die Einstiegskosten aus dem Kostenmodell mit", async () => {
    const result = await runOpportunityPipeline(request(), h.deps());
    if (result.kind !== "ENTERED") throw new Error("Fixture");
    if (result.autoPosition.kind !== "OPENED") throw new Error("Fixture");

    const [position] = await db.select().from(schema.paperPositions);

    // Nicht "100 EUR rein, X Prozent raus": Gebuehren, Preis-Impact und
    // Latenzdrift kommen aus estimateExecutionCosts und stehen ab dem Einstieg
    // in der Zeile. Eine Position, die ihre Kosten erst beim Schliessen bucht,
    // sieht bis dahin besser aus, als sie ist.
    expect(position?.costsPaidMinor).toBeGreaterThan(0n);
    expect(position?.costsPaidMinor).toBe(result.autoPosition.outcome.kind === "FILLED"
      ? result.autoPosition.outcome.costs.total.minor
      : -1n);
    // Und die Kosten liegen unter dem Einsatz — sonst waere die Rechnung kaputt.
    expect(position!.costsPaidMinor).toBeLessThan(PAPER_NOTIONAL.minor);
  });

  it("oeffnet keine Position, wenn die simulierte Ausfuehrung scheitert", async () => {
    // Ohne Quote gibt es keinen Fill — und ohne Fill keine Position. Ein
    // geschaetzter Ersatzpreis waere genau die Erfindung, die eine
    // Paper-Statistik wertlos macht.
    const executor = new PaperExecutor({
      clock: h.clock,
      quotes: new NoQuoteSource(),
      fees: DEFAULT_FEES,
      latency: DEFAULT_LATENCY,
      solPrice: eur(150),
      dexFeeBps: bps(25),
      random: () => 1,
      driftSample: () => 0,
    });

    const result = await runOpportunityPipeline(request(), h.deps({ executor }));
    expect(result.kind).toBe("ENTERED");
    if (result.kind !== "ENTERED") return;

    expect(result.autoPosition.kind).toBe("NOT_FILLED");
    expect(await db.select().from(schema.paperPositions)).toHaveLength(0);
    // Die Gelegenheiten bleiben trotzdem stehen — sie sind Forschungsmaterial.
    expect(await db.select().from(schema.opportunities)).toHaveLength(2);
  });

  it("laesst die MANUAL-Gelegenheit unausgefuehrt warten", async () => {
    const result = await runOpportunityPipeline(request(), h.deps());
    if (result.kind !== "ENTERED") throw new Error("Fixture");

    const manual = result.created.find((c) => c.stream === "MANUAL_PAPER")!;
    const [row] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.id, manual.opportunityId));

    // Der entscheidende Unterschied zu AUTO: keine Position, kein
    // Zustandswechsel. Ein Mensch fehlt noch.
    expect(row?.state).toBe("OFFERED");
    expect(row?.respondBy).not.toBeNull();

    const positions = await db
      .select()
      .from(schema.paperPositions)
      .where(eq(schema.paperPositions.opportunityId, manual.opportunityId));
    expect(positions).toHaveLength(0);
  });

  it("schreibt die Zeitstempelkette, ohne Latenzen zu erfinden", async () => {
    const result = await runOpportunityPipeline(request(), h.deps());
    if (result.kind !== "ENTERED") throw new Error("Fixture");

    const samples = await db.select().from(schema.latencySamples);
    expect(samples).toHaveLength(2);
    for (const sample of samples) {
      expect(sample.observedAt).not.toBeNull();
      expect(sample.decidedAt).not.toBeNull();
      // Die menschlichen Stufen bleiben leer — es gab keinen Menschen.
      expect(sample.seenAt).toBeNull();
      expect(sample.respondedAt).toBeNull();
      expect(sample.confirmedAt).toBeNull();
    }
  });
});

describe("Idempotenz: dasselbe Ereignis zweimal", () => {
  it("erzeugt keine zweite Gelegenheit, Position oder Manual-Zeile", async () => {
    const first = await runOpportunityPipeline(request(), h.deps());
    const second = await runOpportunityPipeline(request(), h.deps());

    expect(first.kind).toBe("ENTERED");
    expect(second.kind).toBe("ENTERED");
    if (second.kind !== "ENTERED") return;

    // Der zweite Lauf erkennt beide Gelegenheiten als Duplikat.
    expect(second.created.every((c) => c.duplicate)).toBe(true);
    // Und er eroeffnet keine zweite Position.
    expect(second.autoPosition.kind).toBe("ALREADY_OPEN");

    expect(await db.select().from(schema.opportunities)).toHaveLength(2);
    expect(await db.select().from(schema.paperPositions)).toHaveLength(1);
    expect(await db.select().from(schema.featureSnapshots)).toHaveLength(1);

    const manual = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.stream, "MANUAL_PAPER"));
    expect(manual).toHaveLength(1);
    expect(manual[0]?.state).toBe("OFFERED");
  });

  it("erzeugt fuer einen anderen Zeitpunkt eine neue Gelegenheit", async () => {
    await runOpportunityPipeline(request(), h.deps());

    // Anderer Beobachtungszeitpunkt heisst anderes Ereignis — das ist kein
    // Duplikat, sondern eine zweite Beobachtung desselben Tokens.
    const later = new Date(T0.getTime() + 600_000);
    h.clock.set(later);
    const second = await runOpportunityPipeline(request({ asOf: later }), h.deps());

    expect(second.kind).toBe("ENTERED");
    expect(await db.select().from(schema.opportunities)).toHaveLength(4);
    expect(await db.select().from(schema.paperPositions)).toHaveLength(2);
  });
});
