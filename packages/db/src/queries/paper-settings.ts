import { and, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../client";
import { paperSettings } from "../schema/settings";
import { systemEvents } from "../schema/ops";

/**
 * Die eine Einstellung, die der Betreiber selbst setzt.
 *
 * Sie lebt in der Datenbank, weil Dashboard und Worker auf verschiedenen
 * Maschinen laufen und die Datenbank die einzige Stelle ist, die beide
 * gemeinsam haben. Vorher stand sie in einer Umgebungsvariablen des Workers —
 * die Oberflaeche konnte sie weder schreiben noch ehrlich anzeigen.
 */

/**
 * Wie viele Aenderungen je Minute hoechstens angenommen werden.
 *
 * Die Einstellung laesst sich ohne Anmeldung setzen — das ist eine bewusste
 * Entscheidung des Betreibers. Offen heisst aber nicht schutzlos: ohne eine
 * Obergrenze waere dieser Weg eine Moeglichkeit, die Datenbank mit
 * Aenderungseintraegen vollzuschreiben. Zehn je Minute ist weit mehr, als ein
 * Mensch am Regler dreht, und weit weniger, als ein Skript schafft.
 */
export const ENTRY_SCORE_MAX_CHANGES_PER_MINUTE = 10;

/** Untergrenze. Darunter waere die Schwelle keine Auswahl mehr. */
export const ENTRY_SCORE_MIN = 10;
/** Obergrenze. Darueber hat in der Messung noch nie ein Coin gelegen. */
export const ENTRY_SCORE_MAX = 95;
/** Voreinstellung, solange nichts gesetzt wurde. Ausdruecklich als solche gefuehrt. */
export const ENTRY_SCORE_DEFAULT = 50;

/** Wie waehlerisch der Bot ist. Siehe `PaperMode` in `@sae/config`. */
export type PaperSettingMode = "VORSICHTIG" | "OFFENSIV";

export function isPaperMode(value: unknown): value is PaperSettingMode {
  return value === "VORSICHTIG" || value === "OFFENSIV";
}

export interface EntryScoreSetting {
  readonly score: number;
  readonly mode: PaperSettingMode;
  /**
   * Woher der Wert stammt.
   *
   * - `SAVED` — der Betreiber hat ihn gespeichert.
   * - `DEFAULT` — es gibt keine Zeile, es gilt die ausgelieferte Zahl.
   *
   * Der Unterschied gehoert in die Anzeige: eine Voreinstellung, die wie eine
   * getroffene Entscheidung aussieht, ist der Anfang jedes Missverstaendnisses
   * darueber, was das System gerade tut.
   */
  readonly source: "SAVED" | "DEFAULT";
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** Ist das eine Zahl, die als Schwelle taugt? Kein Zurechtbiegen. */
export function isValidEntryScore(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ENTRY_SCORE_MIN &&
    value <= ENTRY_SCORE_MAX
  );
}

export async function loadEntryScore(db: Database): Promise<EntryScoreSetting> {
  const [row] = await db
    .select()
    .from(paperSettings)
    .where(eq(paperSettings.id, "singleton"))
    .limit(1);

  if (row === undefined) {
    return {
      score: ENTRY_SCORE_DEFAULT,
      mode: "VORSICHTIG",
      source: "DEFAULT",
      updatedAt: null,
      updatedBy: null,
    };
  }
  // Die Grenzen stehen als CHECK in der Tabelle. Steht hier trotzdem etwas
  // Unmoegliches, ist die Datenbank nicht die, fuer die wir sie halten — dann
  // ist Abbrechen richtiger als Weiterrechnen.
  if (!isValidEntryScore(row.entryScore)) {
    throw new Error("paper_settings.entry_score liegt ausserhalb der erlaubten Grenzen");
  }
  return {
    score: row.entryScore,
    // Ein unbekannter Wert in der Spalte wird NICHT als offensiv gelesen. Die
    // vorsichtige Lesart ist bei einer unklaren Einstellung die richtige.
    mode: isPaperMode(row.mode) ? row.mode : "VORSICHTIG",
    source: "SAVED",
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/**
 * Speichert die Schwelle — und schreibt mit, dass sie geaendert wurde.
 *
 * Der Eintrag in `system_events` ist kein Beiwerk. Eine Kennzahl, die sich
 * stillschweigend aendern laesst, macht jede spaetere Auswertung unlesbar:
 * „warum sind an diesem Tag zwanzig Positionen entstanden" ist ohne die
 * Aenderungsspur nicht beantwortbar.
 */
export async function saveEntryScore(
  db: Database,
  input: {
    readonly score: number;
    readonly actor: string;
    readonly at: Date;
    /** Weggelassen heisst: Modus unveraendert lassen. */
    readonly mode?: PaperSettingMode;
  },
): Promise<EntryScoreSetting> {
  if (!isValidEntryScore(input.score)) {
    throw new Error(
      `Einstiegsschwelle muss eine ganze Zahl zwischen ${String(ENTRY_SCORE_MIN)} und ${String(ENTRY_SCORE_MAX)} sein`,
    );
  }

  return db.transaction(async (tx) => {
    // Die Obergrenze steht HIER und nicht in der Oberflaeche. Eine Pruefung im
    // Formular ist keine Pruefung — wer die Anfrage direkt stellt, umgeht sie.
    const [letzte] = await tx
      .select({ anzahl: sql<number>`count(*)::int` })
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.kind, "ENTRY_SCORE_CHANGED"),
          gte(systemEvents.at, new Date(input.at.getTime() - 60_000)),
        ),
      );
    if ((letzte?.anzahl ?? 0) >= ENTRY_SCORE_MAX_CHANGES_PER_MINUTE) {
      throw new Error("Zu viele Aenderungen in kurzer Zeit. Bitte kurz warten.");
    }

    const vorher = await tx
      .select({ score: paperSettings.entryScore, mode: paperSettings.mode })
      .from(paperSettings)
      .where(eq(paperSettings.id, "singleton"))
      .limit(1);

    // Weggelassener Modus heisst „unveraendert" — und bei noch leerer Tabelle
    // die vorsichtige Lesart. Hier still auf OFFENSIV zu fallen waere die
    // teuerste denkbare Voreinstellung.
    const bisher = vorher[0];
    const mode: PaperSettingMode =
      input.mode ?? (bisher !== undefined && isPaperMode(bisher.mode) ? bisher.mode : "VORSICHTIG");

    await tx
      .insert(paperSettings)
      .values({
        id: "singleton",
        entryScore: input.score,
        mode,
        updatedAt: input.at,
        updatedBy: input.actor,
      })
      .onConflictDoUpdate({
        target: paperSettings.id,
        set: { entryScore: input.score, mode, updatedAt: input.at, updatedBy: input.actor },
      });

    await tx.insert(systemEvents).values({
      kind: "ENTRY_SCORE_CHANGED",
      at: input.at,
      detail: {
        von: bisher?.score ?? null,
        nach: input.score,
        modusVon: bisher?.mode ?? null,
        modusNach: mode,
        durch: input.actor,
      },
    });

    return {
      score: input.score,
      mode,
      source: "SAVED" as const,
      updatedAt: input.at,
      updatedBy: input.actor,
    };
  });
}

/**
 * Uebernimmt eine bestehende Umgebungs-Einstellung EINMAL in die Datenbank.
 *
 * Der Uebergang von „Variable bei Railway" zu „Zeile in der Datenbank" darf
 * eine getroffene Wahl nicht verschlucken. Wer `PAPER_ENTRY_SCORE=35` gesetzt
 * hat, soll nach dem Umzug nicht stillschweigend bei 50 landen — das ist genau
 * die Sorte lautlose Ruecknahme, die dieses System sonst ueberall vermeidet.
 *
 * Danach ist die Datenbank die einzige Quelle. Die Variable wird nicht mehr
 * gelesen; sie noch einmal zu beruecksichtigen hiesse, zwei Wahrheiten zu
 * fuehren und bei jedem Neustart die aeltere gewinnen zu lassen.
 */
export async function seedEntryScoreFromEnv(
  db: Database,
  input: { readonly raw: string | undefined; readonly at: Date },
): Promise<EntryScoreSetting> {
  const vorhanden = await loadEntryScore(db);
  if (vorhanden.source === "SAVED") return vorhanden;

  if (input.raw === undefined || input.raw.trim() === "") return vorhanden;
  const wert = Number(input.raw.trim());
  if (!isValidEntryScore(wert)) return vorhanden;

  return saveEntryScore(db, { score: wert, actor: "PAPER_ENTRY_SCORE", at: input.at });
}
