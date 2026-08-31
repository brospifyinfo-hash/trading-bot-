import { createHash } from "node:crypto";

import type { Clock } from "@sae/core";

/**
 * Idempotenz von Jobs.
 *
 * Ein Job kann aus drei Gruenden zweimal laufen: der Scheduler hat ihn doppelt
 * eingeplant, ein Worker ist nach der Arbeit vor dem Bestaetigen abgestuerzt,
 * oder die Queue hat ihn wiederholt. Alle drei sind normal — und alle drei
 * duerfen keine zweite Gelegenheit, keinen zweiten Snapshot und keinen zweiten
 * Trade erzeugen.
 *
 * Der Schluessel wird aus dem FACHLICHEN Inhalt gebildet, nicht aus der Job-ID:
 * zwei verschiedene Jobs mit demselben Inhalt sind derselbe Vorgang, und
 * derselbe Job mit anderem Inhalt ist ein anderer. Eine Job-ID als Schluessel
 * wuerde beides verwechseln.
 */

export interface IdempotencyRecord<R> {
  readonly key: string;
  readonly completedAt: Date;
  readonly result: R;
}

export interface IdempotencyStore<R = unknown> {
  get(key: string): Promise<IdempotencyRecord<R> | null>;
  /**
   * Legt den Eintrag an. Gibt `false` zurueck, wenn er schon existiert.
   *
   * Das ist der Punkt, an dem die Nebenlaeufigkeit entschieden wird: zwei
   * Worker, die gleichzeitig starten, duerfen nicht beide `true` bekommen. Eine
   * Implementierung ueber eine Datenbank benutzt dafuer ein UNIQUE-INSERT, kein
   * vorheriges SELECT.
   */
  claim(key: string, at: Date): Promise<boolean>;
  complete(key: string, result: R, at: Date): Promise<void>;
  release(key: string): Promise<void>;
}

/** Speicher fuer Tests und einzelne Prozesse. */
export class InMemoryIdempotencyStore<R = unknown> implements IdempotencyStore<R> {
  readonly #claimed = new Map<string, Date>();
  readonly #done = new Map<string, IdempotencyRecord<R>>();

  async get(key: string): Promise<IdempotencyRecord<R> | null> {
    return this.#done.get(key) ?? null;
  }

  async claim(key: string, at: Date): Promise<boolean> {
    if (this.#done.has(key) || this.#claimed.has(key)) return false;
    this.#claimed.set(key, at);
    return true;
  }

  async complete(key: string, result: R, at: Date): Promise<void> {
    this.#claimed.delete(key);
    this.#done.set(key, { key, completedAt: at, result });
  }

  async release(key: string): Promise<void> {
    this.#claimed.delete(key);
  }

  get claimedKeys(): readonly string[] {
    return [...this.#claimed.keys()];
  }
}

/**
 * Stabiler Schluessel aus einem fachlichen Bezeichner.
 *
 * Sortierte Felder, damit dieselben Daten in anderer Reihenfolge denselben
 * Schluessel ergeben — sonst haengt die Idempotenz an der Reihenfolge, in der
 * jemand ein Objektliteral geschrieben hat.
 */
export function idempotencyKey(
  scope: string,
  parts: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const material = Object.keys(parts)
    .sort()
    .map((k) => `${k}=${String(parts[k])}`)
    .join("&");
  return `${scope}:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export type OnceOutcome<R> =
  | { readonly kind: "EXECUTED"; readonly result: R }
  | { readonly kind: "ALREADY_DONE"; readonly result: R; readonly completedAt: Date }
  /** Ein anderer Worker haelt den Schluessel gerade. */
  | { readonly kind: "IN_FLIGHT" };

/**
 * Fuehrt `fn` hoechstens einmal je Schluessel aus.
 *
 * Bei einem Fehler wird der Anspruch freigegeben — sonst blockiert ein
 * abgestuerzter Worker den Vorgang dauerhaft, und das waere schlimmer als eine
 * Wiederholung: der Vorgang faende nie statt.
 */
export async function runOnce<R>(input: {
  readonly store: IdempotencyStore<R>;
  readonly key: string;
  readonly clock: Clock;
  readonly fn: () => Promise<R>;
}): Promise<OnceOutcome<R>> {
  const existing = await input.store.get(input.key);
  if (existing !== null) {
    return { kind: "ALREADY_DONE", result: existing.result, completedAt: existing.completedAt };
  }

  const claimed = await input.store.claim(input.key, input.clock.now());
  if (!claimed) {
    const raced = await input.store.get(input.key);
    if (raced !== null) {
      return { kind: "ALREADY_DONE", result: raced.result, completedAt: raced.completedAt };
    }
    return { kind: "IN_FLIGHT" };
  }

  try {
    const result = await input.fn();
    await input.store.complete(input.key, result, input.clock.now());
    return { kind: "EXECUTED", result };
  } catch (error: unknown) {
    await input.store.release(input.key);
    throw error;
  }
}
