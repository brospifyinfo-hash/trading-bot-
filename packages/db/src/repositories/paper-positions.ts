import { and, eq, sql } from "drizzle-orm";
import { isTestFixture, mulDiv, type Money, type SizingMode, type SourceType, type TradingStream } from "@sae/core";

import type { Database } from "../client";
import { opportunities, paperPositionEvents, paperPositions } from "../schema/opportunities";

/**
 * Schreibpfad fuer simulierte Positionen.
 *
 * Der kritische Vorgang ist `open`: er muss die Gelegenheit von
 * `USER_CONFIRMED` nach `POSITION_OPENED` bringen UND die Position anlegen —
 * beides oder keins. Getrennt ausgefuehrt gibt es zwei Fehlerbilder, und beide
 * sind schlecht: eine Position ohne Zustandswechsel laesst die Gelegenheit
 * offen erscheinen, ein Zustandswechsel ohne Position verliert den Trade.
 *
 * Der Zustandswechsel traegt den erwarteten Ausgangszustand im `WHERE`. Damit
 * kann ein zweiter Aufruf keine zweite Position eroeffnen, selbst wenn der
 * Unique-Index auf `opportunity_id` einmal fehlte.
 */

export type OpenResult =
  | { readonly kind: "OPENED"; readonly positionId: string }
  /** Die Gelegenheit hat bereits eine Position — derselbe Job lief zweimal. */
  | { readonly kind: "ALREADY_OPEN"; readonly positionId: string }
  /** Die Gelegenheit war nicht (mehr) im erwarteten Zustand. */
  | { readonly kind: "NOT_CONFIRMED"; readonly actualState: string | null };

export interface OpenPositionInput {
  readonly opportunityId: string;
  readonly tokenId: string;
  readonly stream: TradingStream;
  readonly sizingMode: SizingMode;
  readonly entryNotional: Money;
  readonly entryAmountRaw: bigint;
  readonly strategyVersionId: string;
  readonly openedAt: Date;
  /** Zustand, aus dem die Position entsteht. Auto: OFFERED, Manual: USER_CONFIRMED. */
  readonly fromState: "OFFERED" | "USER_CONFIRMED";
  /**
   * Herkunft, gespiegelt von der Gelegenheit.
   *
   * Die Datenbank prueft ueber einen zusammengesetzten Fremdschluessel, dass
   * dieser Wert zur Gelegenheit passt — ein falscher Wert erzeugt hier keine
   * Zeile, sondern einen Fehler.
   */
  readonly sourceType: SourceType;
  /**
   * Kosten des Einstiegs in kleinster Waehrungseinheit.
   *
   * Gehoert an die Position und nicht erst an den Ausstieg: ein Paper-Trade,
   * der die Einstiegskosten erst beim Schliessen bucht, sieht bis dahin
   * profitabler aus, als er ist — und genau in dieser Zeit schaut jemand auf
   * das Dashboard.
   */
  readonly entryCostsMinor: bigint;
}

export class PaperPositionRepository {
  constructor(private readonly db: Database) {}

  /** Book a valued sale and, on the final fill, close in the SAME transaction. */
  async settleSale(input: {
    readonly positionId: string;
    readonly expectedVersion: number;
    readonly soldAmountRaw: bigint;
    readonly proceeds: Money;
    readonly costs: Money;
    readonly at: Date;
    readonly reason: string;
    readonly levelIndex: number | null;
    readonly maxAdverseExcursion: number;
    readonly maxFavorableExcursion: number;
    readonly valuation: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly kind: "SETTLED"; readonly position: typeof paperPositions.$inferSelect } | { readonly kind: "STALE" }> {
    if (input.soldAmountRaw <= 0n || input.proceeds.minor < 0n || input.costs.minor < 0n) {
      throw new RangeError("Invalid sale quantities");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(paperPositions).where(eq(paperPositions.id, input.positionId)).limit(1);
      if (row === undefined || row.closedAt !== null || row.version !== input.expectedVersion) return { kind: "STALE" as const };
      if (row.currency !== input.proceeds.currency || row.currency !== input.costs.currency) throw new TypeError("Sale currency mismatch");
      if (input.at < row.openedAt || input.soldAmountRaw > row.remainingAmountRaw || row.entryAmountRaw <= 0n) throw new RangeError("Invalid sale state");
      // Cumulative allocation conserves every cent across arbitrarily rounded partials.
      const soldBefore = row.entryAmountRaw - row.remainingAmountRaw;
      const basis = mulDiv(row.entryNotionalMinor, soldBefore + input.soldAmountRaw, row.entryAmountRaw, "floor")
        - mulDiv(row.entryNotionalMinor, soldBefore, row.entryAmountRaw, "floor");
      const remaining = row.remainingAmountRaw - input.soldAmountRaw;
      const final = remaining === 0n;
      const [updated] = await tx.update(paperPositions).set({
        remainingAmountRaw: remaining,
        // Gross realized result; costs are stored separately, never silently zeroed.
        realizedPnlMinor: row.realizedPnlMinor + input.proceeds.minor - basis,
        costsPaidMinor: row.costsPaidMinor + input.costs.minor,
        maxAdverseExcursion: input.maxAdverseExcursion,
        maxFavorableExcursion: input.maxFavorableExcursion,
        closedAt: final ? input.at : null,
        exitReason: final ? input.reason : null,
        version: row.version + 1,
      }).where(and(eq(paperPositions.id, row.id), eq(paperPositions.version, row.version), sql`${paperPositions.closedAt} is null`)).returning();
      if (updated === undefined) return { kind: "STALE" as const };
      await tx.insert(paperPositionEvents).values({
        positionId: row.id, kind: final ? "EXIT_FILL" : "PARTIAL_TP", at: input.at,
        detail: {
          levelIndex: input.levelIndex, soldAmountRaw: input.soldAmountRaw.toString(),
          proceedsMinor: input.proceeds.minor.toString(), costBasisMinor: basis.toString(),
          costsMinor: input.costs.minor.toString(), currency: row.currency,
          reason: input.reason, valuation: input.valuation,
        },
      });
      if (final) await tx.insert(paperPositionEvents).values({
        positionId: row.id, kind: "CLOSED", at: input.at, detail: { exitReason: input.reason },
      });
      return { kind: "SETTLED" as const, position: updated };
    });
  }

  async open(input: OpenPositionInput): Promise<OpenResult> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: paperPositions.id })
        .from(paperPositions)
        .where(eq(paperPositions.opportunityId, input.opportunityId))
        .limit(1);
      if (existing[0] !== undefined) {
        return { kind: "ALREADY_OPEN" as const, positionId: existing[0].id };
      }

      const moved = await tx
        .update(opportunities)
        .set({ state: "POSITION_OPENED", closedAt: input.openedAt })
        .where(
          and(
            eq(opportunities.id, input.opportunityId),
            eq(opportunities.state, input.fromState),
          ),
        )
        .returning({ id: opportunities.id });

      if (moved.length === 0) {
        const [row] = await tx
          .select({ state: opportunities.state })
          .from(opportunities)
          .where(eq(opportunities.id, input.opportunityId))
          .limit(1);
        // Kein Wurf: „nicht im erwarteten Zustand" ist ein regulaeres Ergebnis,
        // etwa wenn die Gelegenheit inzwischen abgelaufen ist.
        return { kind: "NOT_CONFIRMED" as const, actualState: row?.state ?? null };
      }

      const [position] = await tx
        .insert(paperPositions)
        .values({
          opportunityId: input.opportunityId,
          tokenId: input.tokenId,
          stream: input.stream,
          sizingMode: input.sizingMode,
          entryNotionalMinor: input.entryNotional.minor,
          currency: input.entryNotional.currency,
          entryAmountRaw: input.entryAmountRaw,
          remainingAmountRaw: input.entryAmountRaw,
          strategyVersionId: input.strategyVersionId,
          openedAt: input.openedAt,
          costsPaidMinor: input.entryCostsMinor,
          sourceType: input.sourceType,
          isTestFixture: isTestFixture(input.sourceType),
        })
        .returning({ id: paperPositions.id });

      if (position === undefined) throw new Error("Position konnte nicht angelegt werden");

      await tx.insert(paperPositionEvents).values({
        positionId: position.id,
        kind: "OPENED",
        at: input.openedAt,
        detail: {
          entryNotionalMinor: input.entryNotional.minor.toString(),
          entryCostsMinor: input.entryCostsMinor.toString(),
          currency: input.entryNotional.currency,
          sizingMode: input.sizingMode,
        },
      });

      return { kind: "OPENED" as const, positionId: position.id };
    });
  }

  /**
   * Teilverkauf oder Anpassung.
   *
   * `expectedVersion` ist optimistische Sperre: zwei Worker, die dieselbe
   * Position gleichzeitig anfassen, duerfen sich nicht gegenseitig
   * ueberschreiben. Der zweite bekommt `STALE` und liest neu, statt eine
   * Teilmenge zu verlieren.
   */
  async applyFill(input: {
    readonly positionId: string;
    readonly expectedVersion: number;
    readonly soldAmountRaw: bigint;
    readonly realizedPnlMinorDelta: bigint;
    readonly costsPaidMinorDelta: bigint;
    readonly at: Date;
    readonly kind: string;
    readonly detail: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly kind: "APPLIED"; readonly version: number } | { readonly kind: "STALE" }> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(paperPositions)
        .set({
          remainingAmountRaw: sql`${paperPositions.remainingAmountRaw} - ${input.soldAmountRaw}`,
          realizedPnlMinor: sql`${paperPositions.realizedPnlMinor} + ${input.realizedPnlMinorDelta}`,
          costsPaidMinor: sql`${paperPositions.costsPaidMinor} + ${input.costsPaidMinorDelta}`,
          version: sql`${paperPositions.version} + 1`,
        })
        .where(
          and(
            eq(paperPositions.id, input.positionId),
            eq(paperPositions.version, input.expectedVersion),
          ),
        )
        .returning({ version: paperPositions.version });

      if (updated[0] === undefined) return { kind: "STALE" as const };

      await tx.insert(paperPositionEvents).values({
        positionId: input.positionId,
        kind: input.kind,
        at: input.at,
        detail: input.detail as never,
      });

      return { kind: "APPLIED" as const, version: updated[0].version };
    });
  }

  async close(input: {
    readonly positionId: string;
    readonly expectedVersion: number;
    readonly closedAt: Date;
    readonly exitReason: string;
    readonly maxAdverseExcursion: number | null;
    readonly maxFavorableExcursion: number | null;
    readonly exitEfficiency: number | null;
  }): Promise<{ readonly kind: "CLOSED" } | { readonly kind: "STALE" }> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(paperPositions)
        .set({
          closedAt: input.closedAt,
          exitReason: input.exitReason,
          maxAdverseExcursion: input.maxAdverseExcursion,
          maxFavorableExcursion: input.maxFavorableExcursion,
          exitEfficiency: input.exitEfficiency,
          version: sql`${paperPositions.version} + 1`,
        })
        .where(
          and(
            eq(paperPositions.id, input.positionId),
            eq(paperPositions.version, input.expectedVersion),
            sql`${paperPositions.closedAt} is null`,
          ),
        )
        .returning({ id: paperPositions.id });

      if (updated[0] === undefined) return { kind: "STALE" as const };

      await tx.insert(paperPositionEvents).values({
        positionId: input.positionId,
        kind: "CLOSED",
        at: input.closedAt,
        detail: { exitReason: input.exitReason },
      });

      return { kind: "CLOSED" as const };
    });
  }

  async openPositions(stream?: TradingStream): Promise<readonly (typeof paperPositions.$inferSelect)[]> {
    const base = this.db.select().from(paperPositions);
    return stream === undefined
      ? base.where(sql`${paperPositions.closedAt} is null`)
      : base.where(and(sql`${paperPositions.closedAt} is null`, eq(paperPositions.stream, stream)));
  }
}
