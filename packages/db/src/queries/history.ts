import { desc, eq } from "drizzle-orm";

import type { Database } from "../client";
import { systemEvents } from "../schema/ops";

/**
 * Was der Betreiber eingestellt hat, und wann.
 *
 * Die Kehrseite jeder Handelshistorie: eine Reihe von Trades ohne die
 * Aenderungen an den Regeln ist nicht auswertbar. „Warum sind an diesem
 * Nachmittag zwanzig Positionen entstanden" beantwortet keine Trade-Liste —
 * die Antwort ist „weil die Schwelle von 70 auf 10 ging", und die steht hier.
 *
 * Gelesen wird aus `system_events`, wo `saveEntryScore` jede Aenderung
 * hinterlegt. Keine zweite Tabelle, keine Doppelfuehrung.
 */
export interface SettingChange {
  readonly at: Date;
  readonly scoreVon: number | null;
  readonly scoreNach: number | null;
  readonly modusVon: string | null;
  readonly modusNach: string | null;
  /** In Cent. `null` heisst „keine Vorgabe". */
  readonly einsatzVon: bigint | null;
  readonly einsatzNach: bigint | null;
  readonly durch: string | null;
}

function zahl(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  // Begrenzt, weil der Wert aus einem JSON-Feld kommt und in die Anzeige geht.
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

function betrag(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  return BigInt(value);
}

export async function loadSettingsHistory(
  db: Database,
  limit = 50,
): Promise<readonly SettingChange[]> {
  const rows = await db
    .select({ at: systemEvents.at, detail: systemEvents.detail })
    .from(systemEvents)
    .where(eq(systemEvents.kind, "ENTRY_SCORE_CHANGED"))
    .orderBy(desc(systemEvents.at))
    .limit(limit);

  return rows.map((row) => {
    const d = (typeof row.detail === "object" && row.detail !== null ? row.detail : {}) as Record<
      string,
      unknown
    >;
    return {
      at: row.at,
      scoreVon: zahl(d.von),
      scoreNach: zahl(d.nach),
      modusVon: text(d.modusVon),
      modusNach: text(d.modusNach),
      einsatzVon: betrag(d.einsatzVon),
      einsatzNach: betrag(d.einsatzNach),
      durch: text(d.durch),
    };
  });
}
