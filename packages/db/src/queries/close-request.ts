import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../client";
import { paperPositions } from "../schema/opportunities";
import { systemEvents } from "../schema/ops";

/**
 * Einen Verkauf von Hand anfordern.
 *
 * Es wird NICHT verkauft. Es wird vermerkt, dass verkauft werden soll — der
 * Positions-Monitor fuehrt es im naechsten Takt aus, mit echtem Quote und
 * echter Bewertung. Alles andere hiesse, hier einen Ausstiegskurs zu
 * erfinden, und damit waere die Papier-Statistik ab diesem Trade wertlos.
 *
 * `version` wird absichtlich nicht erhoeht: der Vermerk ist keine Aenderung
 * der Buchfuehrung, und ein Hochzaehlen wuerde eine gerade laufende
 * Abrechnung des Monitors ins Leere laufen lassen.
 */
export type CloseRequestResult =
  | { readonly kind: "REQUESTED"; readonly at: Date }
  /** Schon angefordert. Ein zweiter Klick aendert nichts und sagt das. */
  | { readonly kind: "ALREADY_REQUESTED"; readonly at: Date }
  /** Die Position ist bereits geschlossen oder existiert nicht. */
  | { readonly kind: "NOT_OPEN" };

export async function requestPositionClose(
  db: Database,
  input: { readonly positionId: string; readonly actor: string; readonly at: Date },
): Promise<CloseRequestResult> {
  return db.transaction(async (tx) => {
    const [vorher] = await tx
      .select({
        closedAt: paperPositions.closedAt,
        closeRequestedAt: paperPositions.closeRequestedAt,
      })
      .from(paperPositions)
      .where(eq(paperPositions.id, input.positionId))
      .limit(1);

    if (vorher === undefined || vorher.closedAt !== null) return { kind: "NOT_OPEN" };
    if (vorher.closeRequestedAt !== null) {
      return { kind: "ALREADY_REQUESTED", at: vorher.closeRequestedAt };
    }

    const geaendert = await tx
      .update(paperPositions)
      .set({ closeRequestedAt: input.at, closeRequestedBy: input.actor })
      .where(and(eq(paperPositions.id, input.positionId), isNull(paperPositions.closedAt)))
      .returning({ id: paperPositions.id });
    if (geaendert.length === 0) return { kind: "NOT_OPEN" };

    // Ein Eingriff von Hand gehoert in die Aenderungsspur. Ohne ihn waere
    // spaeter nicht unterscheidbar, ob eine Regel oder ein Mensch verkauft
    // hat — und das ist bei der Auswertung der entscheidende Unterschied.
    await tx.insert(systemEvents).values({
      kind: "POSITION_CLOSE_REQUESTED",
      at: input.at,
      detail: { positionId: input.positionId, durch: input.actor },
    });

    return { kind: "REQUESTED", at: input.at };
  });
}

/** Nimmt eine Anforderung zurueck, solange der Monitor sie nicht ausgefuehrt hat. */
export async function cancelPositionClose(
  db: Database,
  input: { readonly positionId: string; readonly actor: string; readonly at: Date },
): Promise<CloseRequestResult> {
  return db.transaction(async (tx) => {
    const geaendert = await tx
      .update(paperPositions)
      .set({ closeRequestedAt: null, closeRequestedBy: null })
      .where(and(eq(paperPositions.id, input.positionId), isNull(paperPositions.closedAt),
        sql`${paperPositions.closeRequestedAt} is not null`))
      .returning({ id: paperPositions.id });
    if (geaendert.length === 0) return { kind: "NOT_OPEN" };

    await tx.insert(systemEvents).values({
      kind: "POSITION_CLOSE_CANCELLED",
      at: input.at,
      detail: { positionId: input.positionId, durch: input.actor },
    });
    return { kind: "REQUESTED", at: input.at };
  });
}
