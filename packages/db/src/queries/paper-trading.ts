import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "../client";
import * as schema from "../schema/index";
import { PAPER_INITIAL_CASH, readPaperAccount } from "./paper-account";

/** One read-only snapshot; shares the worker ledger, without locking its writes. */
export async function loadPaperTrading(input: { db: Database; strategyName: string; now: Date }) {
  return input.db.transaction(async (tx) => {
    const [family] = await tx.select().from(schema.strategies)
      .where(eq(schema.strategies.name, input.strategyName)).limit(1);
    if (!family) return { kind: "WAITING" as const, updatedAt: input.now };
    const account = await readPaperAccount({
      db: tx, strategyId: family.id, initialCash: PAPER_INITIAL_CASH, asOf: input.now,
    });
    if (account.kind !== "READY") return { kind: "BLOCKED" as const, updatedAt: input.now };
    // Die Strategieversion wandert mit. Sie traegt Schwelle UND Modus im Namen
    // (`2.0.0-s10-offensiv`), und damit ist an jeder einzelnen Position
    // ablesbar, unter welcher Regel sie entstanden ist. Ohne sie waere die
    // Historie eine Liste von Trades ohne Zusammenhang.
    const rows = await tx.select({ position: schema.paperPositions, token: schema.tokens,
      version: schema.strategyVersions.version })
      .from(schema.paperPositions)
      .innerJoin(schema.strategyVersions, eq(schema.strategyVersions.id, schema.paperPositions.strategyVersionId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.paperPositions.tokenId))
      .where(and(eq(schema.strategyVersions.strategyId, family.id),
        eq(schema.paperPositions.stream, "AUTO_PAPER"), eq(schema.paperPositions.sizingMode, "RISK_BASED"),
        eq(schema.paperPositions.sourceType, "LIVE"), eq(schema.paperPositions.isTestFixture, false)));
    const closed = rows.filter((r) => r.position.closedAt !== null)
      .sort((a, b) => b.position.closedAt!.getTime() - a.position.closedAt!.getTime() ||
        a.position.id.localeCompare(b.position.id));
    const offen = rows
      .filter((r) => r.position.closedAt === null)
      .sort((a, b) => b.position.openedAt.getTime() - a.position.openedAt.getTime());

    /*
     * Der aktuelle Stand jeder offenen Position.
     *
     * Bis hierher zeigte das Dashboard ausschliesslich REALISIERTE Ergebnisse
     * und schrieb darunter, unrealisierte Kursgewinne seien nicht enthalten.
     * Das war ehrlich und fuer die eine Frage, die man bei einer offenen
     * Position hat, unbrauchbar: steht sie im Plus oder im Minus?
     *
     * Gerechnet wird wie im Positions-Monitor, aus demselben Verhaeltnis
     * zweier Preise DERSELBEN Reihe (`token_snapshots.priceUsd`): Kurs jetzt
     * geteilt durch Kurs beim Einstieg. Ein Verhaeltnis ist waehrungsfrei und
     * laesst sich deshalb auf den Einstand in Euro anwenden, ohne irgendwo
     * einen Wechselkurs zu erfinden.
     *
     * Fehlt einer der beiden Preise, ist das Ergebnis `null` und nicht 0 —
     * „nicht messbar" und „kein Gewinn" sind zwei verschiedene Aussagen, und
     * bei einer offenen Position ist der Unterschied der ganze Punkt.
     */
    const tokenIds = [...new Set(offen.map((r) => r.position.tokenId))];
    const aktuelle = tokenIds.length === 0 ? [] : await tx
      .selectDistinctOn([schema.tokenSnapshots.tokenId], {
        tokenId: schema.tokenSnapshots.tokenId,
        priceUsd: schema.tokenSnapshots.priceUsd,
        observedAt: schema.tokenSnapshots.observedAt,
      })
      .from(schema.tokenSnapshots)
      .where(and(inArray(schema.tokenSnapshots.tokenId, tokenIds),
        lte(schema.tokenSnapshots.observedAt, input.now)))
      .orderBy(schema.tokenSnapshots.tokenId, desc(schema.tokenSnapshots.observedAt));
    const jetztNach = new Map(aktuelle.map((r) => [r.tokenId, r]));

    const live = await Promise.all(offen.map(async ({ position }) => {
      // Der Einstiegspreis haengt am Eroeffnungszeitpunkt DIESER Position und
      // nicht am Token — deshalb je Position eine Abfrage. Bei hoechstens
      // zwanzig offenen Positionen ist das billiger als die Verrenkung, es in
      // eine einzige Abfrage zu zwingen.
      const [beiEinstieg] = await tx
        .select({ priceUsd: schema.tokenSnapshots.priceUsd })
        .from(schema.tokenSnapshots)
        .where(and(eq(schema.tokenSnapshots.tokenId, position.tokenId),
          lte(schema.tokenSnapshots.observedAt, position.openedAt)))
        .orderBy(desc(schema.tokenSnapshots.observedAt))
        .limit(1);

      const jetzt = jetztNach.get(position.tokenId);
      const einstieg = beiEinstieg?.priceUsd ?? null;
      const kurs = jetzt?.priceUsd ?? null;

      // Der noch im Markt stehende Einstand: der Anteil des Einsatzes, der
      // nicht verkauft ist. Ohne diesen Anteil waere ein teilweise
      // abgebauter Trade mit seinem vollen Einsatz bewertet.
      const einstandRest = position.entryAmountRaw === 0n ? 0n
        : (position.entryNotionalMinor * position.remainingAmountRaw) / position.entryAmountRaw;

      if (kurs === null || einstieg === null || einstieg <= 0 || kurs < 0 ||
        jetzt === undefined || position.remainingAmountRaw <= 0n) {
        return { positionId: position.id, kind: "UNKNOWN" as const,
          reason: kurs === null ? "KEIN_AKTUELLER_KURS" as const
            : einstieg === null || einstieg <= 0 ? "KEIN_EINSTIEGSKURS" as const
            : "KEIN_BESTAND" as const,
          einstandRestMinor: einstandRest };
      }

      const verhaeltnis = kurs / einstieg;
      if (!Number.isFinite(verhaeltnis)) {
        return { positionId: position.id, kind: "UNKNOWN" as const,
          reason: "KEIN_AKTUELLER_KURS" as const, einstandRestMinor: einstandRest };
      }
      // Ganzzahlig gerechnet: Geld ist in diesem System nie eine
      // Gleitkommazahl. Das Verhaeltnis wird auf sechs Stellen festgemacht,
      // dieselbe Genauigkeit wie im Positions-Monitor.
      const skala = 1_000_000n;
      const faktor = BigInt(Math.round(verhaeltnis * 1_000_000));
      const wertJetztMinor = (einstandRest * faktor) / skala;
      return {
        positionId: position.id,
        kind: "MEASURED" as const,
        einstandRestMinor: einstandRest,
        wertJetztMinor,
        unrealisiertMinor: wertJetztMinor - einstandRest,
        verhaeltnis,
        kursObservedAt: jetzt.observedAt,
        // Die Frische gehoert dazu. Ein Stand von vor einer Stunde ist bei
        // Memecoins keine Auskunft ueber das Jetzt, und wer sie ohne Alter
        // liest, haelt sie fuer eine.
        kursAlterSekunden: Math.max(0,
          Math.round((input.now.getTime() - jetzt.observedAt.getTime()) / 1_000)),
      };
    }));

    return { kind: "READY" as const, updatedAt: input.now, account, initialCash: PAPER_INITIAL_CASH,
      open: offen,
      live: new Map(live.map((l) => [l.positionId, l])),
      closed: closed.slice(0, 100), closedCount: closed.length };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
export type PaperTrading = Awaited<ReturnType<typeof loadPaperTrading>>;
