import { asc, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client";
import { jobQueue } from "../schema/queue";

/**
 * Warum Auftraege endgueltig gescheitert sind.
 *
 * Das Dashboard zeigte bis hierher `dead: 6688` — eine Zahl ohne Ursache. Der
 * Betreiber las sie in der Migrationspruefung als Warnung und konnte nichts
 * damit anfangen; dieselbe stille Null wie §140, §144, §145 und §150, nur mit
 * einer grossen Zahl statt einer kleinen.
 *
 * ### Warum hier KEIN Fehlertext steht
 *
 * `job_queue.last_error` ist Freitext aus einer Ausnahme. Eine
 * Postgres-Fehlermeldung enthaelt die Verbindungszeichenfolge samt Passwort,
 * und die Oberflaeche laeuft auf Wunsch des Betreibers OHNE Anmeldung — jeder,
 * der die Adresse kennt, liest mit. Diese Auszaehlung fuehrt deshalb
 * ausschliesslich `kind` und `last_failure_class`: beides geschlossene
 * Aufzaehlungen aus eigenem Code, beides ohne fremden Text.
 *
 * Der Fehlertext bleibt lesbar — aber nur mit Anmeldung. Diese Trennung ist
 * der eigentliche Zweck der Datei.
 */

export interface DeadLetterGroup {
  readonly kind: string;
  /** `UNKNOWN`, wenn der Auftrag ohne Klassifizierung gestorben ist. */
  readonly failureClass: string;
  readonly anzahl: number;
  readonly aeltester: Date;
  readonly neuester: Date;
}

export interface DeadLetterBreakdown {
  readonly gesamt: number;
  readonly gruppen: readonly DeadLetterGroup[];
}

/** Nur eigene Etiketten. Alles andere wird nicht angezeigt. */
const ETIKETT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export async function loadDeadLetterBreakdown(
  db: Database,
  limit = 20,
): Promise<DeadLetterBreakdown> {
  const rows = await db
    .select({
      kind: jobQueue.kind,
      failureClass: jobQueue.lastFailureClass,
      anzahl: sql<number>`count(*)::int`,
      aeltester: sql<Date | string>`min(${jobQueue.finishedAt})`,
      neuester: sql<Date | string>`max(${jobQueue.finishedAt})`,
    })
    .from(jobQueue)
    .where(eq(jobQueue.state, "DEAD"))
    .groupBy(jobQueue.kind, jobQueue.lastFailureClass)
    .orderBy(desc(sql`count(*)`), asc(jobQueue.kind))
    .limit(limit);

  const gruppen: DeadLetterGroup[] = [];
  let gesamt = 0;
  for (const r of rows) {
    const klasse = r.failureClass ?? "UNKNOWN";
    if (!ETIKETT.test(r.kind) || !ETIKETT.test(klasse)) continue;
    if (!Number.isSafeInteger(r.anzahl)) continue;
    // Ohne `finished_at` gibt es keinen Zeitraum. Ein gestorbener Auftrag ohne
    // Abschlusszeit waere ein eigener Befund — er wird nicht zu „jetzt"
    // gerundet, sondern ausgelassen.
    const aeltester = r.aeltester === null ? null : new Date(r.aeltester);
    const neuester = r.neuester === null ? null : new Date(r.neuester);
    if (aeltester === null || neuester === null) continue;
    if (Number.isNaN(aeltester.getTime()) || Number.isNaN(neuester.getTime())) continue;
    gruppen.push({ kind: r.kind, failureClass: klasse, anzahl: r.anzahl, aeltester, neuester });
    gesamt += r.anzahl;
  }
  return { gesamt, gruppen };
}
