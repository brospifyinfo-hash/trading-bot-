import { createHash } from "node:crypto";

/**
 * Research-Batch mit eingefrorenen Zeitgrenzen.
 *
 * §110 und §145 verlangen, dass Forschung reproduzierbar ist. Der eigentliche
 * Zweck ist aber I-6: **Hypothese und Out-of-Sample-Pruefung duerfen nicht aus
 * derselben Periode stammen.**
 *
 * Der Fehler passiert nicht aus boesem Willen. Er passiert so: man schaut sich
 * die Daten an, findet ein Muster, prueft es — und waehlt den Pruefzeitraum so,
 * dass er zu dem passt, was man gesehen hat. Danach ist das Ergebnis
 * zwangslaeufig gut, und niemand kann hinterher rekonstruieren, in welcher
 * Reihenfolge das passiert ist.
 *
 * Deshalb wird die Grenze VOR der Hypothese festgeschrieben und mit einem Hash
 * versehen. `assertFrozenBefore` weist jede Hypothese ab, die aelter ist als
 * das Einfrieren — die Reihenfolge ist damit pruefbar und nicht mehr eine Frage
 * des guten Gewissens.
 */

export interface ResearchBatch {
  readonly batchId: string;
  /** Bereich, in dem Hypothesen gebildet werden duerfen. */
  readonly trainFrom: Date;
  readonly trainTo: Date;
  /** Bereich, in dem sie geprueft werden. Liegt nach dem Training. */
  readonly oosFrom: Date;
  readonly oosTo: Date;
  /**
   * Sperrfrist zwischen Training und Pruefung.
   *
   * Ohne sie leckt das Training in die Pruefung: eine Position, die kurz vor
   * `trainTo` eroeffnet wurde, laeuft in den Pruefzeitraum hinein, und ihr
   * Ausgang gehoert beiden Bereichen. Die Sperrfrist muss deshalb mindestens
   * so lang sein wie die maximale Haltedauer.
   */
  readonly embargoSeconds: number;
  /** Zeitpunkt des Einfrierens. Alles Spaetere ist Hypothese. */
  readonly frozenAt: Date;
  /** Hash ueber die Grenzen. Eine spaetere Verschiebung faellt damit auf. */
  readonly boundaryHash: string;
}

export type BatchValidationError =
  | "TRAIN_RANGE_INVERTED"
  | "OOS_RANGE_INVERTED"
  | "OOS_BEFORE_TRAIN"
  | "EMBARGO_TOO_SHORT"
  | "EMBARGO_NEGATIVE";

export interface BatchBoundaries {
  readonly trainFrom: Date;
  readonly trainTo: Date;
  readonly oosFrom: Date;
  readonly oosTo: Date;
  readonly embargoSeconds: number;
}

export function boundaryHashOf(b: BatchBoundaries): string {
  const material = [
    b.trainFrom.toISOString(),
    b.trainTo.toISOString(),
    b.oosFrom.toISOString(),
    b.oosTo.toISOString(),
    String(b.embargoSeconds),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Prueft die Grenzen, bevor sie eingefroren werden.
 *
 * `maxHoldingSeconds` ist Pflicht: ohne die maximale Haltedauer laesst sich
 * nicht sagen, ob die Sperrfrist reicht.
 */
export function validateBoundaries(
  b: BatchBoundaries,
  maxHoldingSeconds: number,
): readonly BatchValidationError[] {
  const errors: BatchValidationError[] = [];
  if (b.trainTo.getTime() <= b.trainFrom.getTime()) errors.push("TRAIN_RANGE_INVERTED");
  if (b.oosTo.getTime() <= b.oosFrom.getTime()) errors.push("OOS_RANGE_INVERTED");
  if (b.embargoSeconds < 0) errors.push("EMBARGO_NEGATIVE");
  else if (b.embargoSeconds < maxHoldingSeconds) errors.push("EMBARGO_TOO_SHORT");

  const embargoEnd = b.trainTo.getTime() + Math.max(0, b.embargoSeconds) * 1_000;
  if (b.oosFrom.getTime() < embargoEnd) errors.push("OOS_BEFORE_TRAIN");

  return errors;
}

export class BoundariesInvalidError extends Error {
  constructor(readonly errors: readonly BatchValidationError[]) {
    super(`Zeitgrenzen unbrauchbar: ${errors.join(", ")}`);
    this.name = "BoundariesInvalidError";
  }
}

export function freezeBatch(input: {
  readonly batchId: string;
  readonly boundaries: BatchBoundaries;
  readonly maxHoldingSeconds: number;
  readonly at: Date;
}): ResearchBatch {
  const errors = validateBoundaries(input.boundaries, input.maxHoldingSeconds);
  if (errors.length > 0) throw new BoundariesInvalidError(errors);
  return {
    batchId: input.batchId,
    ...input.boundaries,
    frozenAt: input.at,
    boundaryHash: boundaryHashOf(input.boundaries),
  };
}

export class HypothesisBeforeFreezeError extends Error {
  constructor(hypothesisAt: Date, frozenAt: Date) {
    super(
      `Hypothese vom ${hypothesisAt.toISOString()} ist aelter als das Einfrieren ` +
        `(${frozenAt.toISOString()}) — die Grenzen koennten zu ihr passend gewaehlt worden sein.`,
    );
    this.name = "HypothesisBeforeFreezeError";
  }
}

/** Die Reihenfolgepruefung: erst einfrieren, dann behaupten. */
export function assertFrozenBefore(batch: ResearchBatch, hypothesisAt: Date): void {
  if (hypothesisAt.getTime() < batch.frozenAt.getTime()) {
    throw new HypothesisBeforeFreezeError(hypothesisAt, batch.frozenAt);
  }
}

export class BoundariesTamperedError extends Error {
  constructor(batchId: string) {
    super(`Zeitgrenzen von Batch ${batchId} stimmen nicht mehr mit ihrem Hash ueberein.`);
    this.name = "BoundariesTamperedError";
  }
}

/** Prueft, ob die Grenzen seit dem Einfrieren verschoben wurden. */
export function assertBoundariesIntact(batch: ResearchBatch): void {
  if (boundaryHashOf(batch) !== batch.boundaryHash) {
    throw new BoundariesTamperedError(batch.batchId);
  }
}

/**
 * Anteil gemeinsamer Trainingszeit zweier Batches.
 *
 * Nicht verboten, aber gemessen: zwei Batches ueber weitgehend dieselben Daten
 * liefern dieselbe Erkenntnis zweimal, und die zweite sieht dann aus wie eine
 * unabhaengige Bestaetigung (I-12). Das ist der Punkt, an dem aus einer
 * Beobachtung ein „belegter Zusammenhang" wird, ohne dass ein einziger neuer
 * Datenpunkt hinzugekommen waere.
 */
export function trainingOverlapFraction(a: ResearchBatch, b: ResearchBatch): number {
  const start = Math.max(a.trainFrom.getTime(), b.trainFrom.getTime());
  const end = Math.min(a.trainTo.getTime(), b.trainTo.getTime());
  const overlap = Math.max(0, end - start);
  const shorter = Math.min(
    a.trainTo.getTime() - a.trainFrom.getTime(),
    b.trainTo.getTime() - b.trainFrom.getTime(),
  );
  if (shorter <= 0) return 0;
  return overlap / shorter;
}

/**
 * Ab wann zwei Befunde nicht mehr als unabhaengig gelten.
 *
 * Berichtskonvention, keine Messung: ein Viertel gemeinsamer Trainingszeit ist
 * der Punkt, ab dem ich zwei Befunde nicht mehr getrennt zaehlen wuerde. Sobald
 * genug Batches vorliegen, um die Korrelation ihrer Ergebnisse tatsaechlich zu
 * messen, gehoert der Wert ersetzt.
 */
export const MAX_INDEPENDENT_OVERLAP = 0.25;

export function areIndependent(
  a: ResearchBatch,
  b: ResearchBatch,
  maxOverlap: number = MAX_INDEPENDENT_OVERLAP,
): boolean {
  return trainingOverlapFraction(a, b) <= maxOverlap;
}

/**
 * Zaehlt nur Befunde aus hinreichend getrennten Batches.
 *
 * Gibt zurueck, wie viele davon als unabhaengig gelten — und welche verworfen
 * wurden. Beides, damit die Zahl nachvollziehbar bleibt: „drei Bestaetigungen"
 * und „drei Bestaetigungen, davon zwei aus denselben Daten" sind verschiedene
 * Aussagen.
 */
export function countIndependentConfirmations(
  batches: readonly ResearchBatch[],
  maxOverlap: number = MAX_INDEPENDENT_OVERLAP,
): { readonly independent: readonly string[]; readonly redundant: readonly string[] } {
  const independent: ResearchBatch[] = [];
  const redundant: string[] = [];
  // Aeltester zuerst: die erste Beobachtung zaehlt, spaetere Wiederholungen
  // ueber dieselben Daten nicht.
  const ordered = [...batches].sort((a, b) => a.trainFrom.getTime() - b.trainFrom.getTime());
  for (const batch of ordered) {
    if (independent.every((kept) => areIndependent(kept, batch, maxOverlap))) {
      independent.push(batch);
    } else {
      redundant.push(batch.batchId);
    }
  }
  return { independent: independent.map((b) => b.batchId), redundant };
}
