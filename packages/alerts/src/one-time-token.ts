import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "@sae/core";

/**
 * Einmal-Token fuer den INVEST-NOW-Button.
 *
 * Drei Eigenschaften, und jede einzelne ist noetig:
 *
 * 1. Gespeichert wird ausschliesslich der SHA-256-Hash. Der Klartext existiert
 *    nur in der E-Mail. Wer die Datenbank liest, kann keinen Trade ausloesen.
 *
 * 2. Der Token IDENTIFIZIERT einen Intent, er AUTORISIERT nichts. Die Handlung
 *    braucht zusaetzlich eine eingeloggte Session. Wer die Mail abfaengt, kommt
 *    damit nicht weiter — das ist der Unterschied zwischen einem Link, der etwas
 *    oeffnet, und einem Link, der etwas tut.
 *
 * 3. Einmalig und kurzlebig. Ein zweiter Klick auf denselben Link laeuft ins
 *    Leere, ein alter Link aus dem Postfach ebenso.
 */

export interface StoredToken {
  readonly tokenHash: string;
  readonly intentId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface IssuedToken {
  /** Nur fuer die E-Mail. Wird nirgends persistiert und nirgends geloggt. */
  readonly plaintext: string;
  readonly stored: StoredToken;
}

export const TOKEN_BYTES = 32;
export const DEFAULT_TTL_MS = 15 * 60 * 1_000;

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function issueToken(
  intentId: string,
  clock: Clock,
  ttlMs: number = DEFAULT_TTL_MS,
): IssuedToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    plaintext,
    stored: {
      tokenHash: hashToken(plaintext),
      intentId,
      expiresAt: new Date(clock.now().getTime() + ttlMs),
      consumedAt: null,
    },
  };
}

export type TokenRejection =
  | "UNKNOWN_TOKEN"
  | "ALREADY_CONSUMED"
  | "EXPIRED"
  | "INTENT_MISMATCH"
  | "NOT_AUTHENTICATED";

export type TokenCheck =
  | { readonly ok: true; readonly intentId: string }
  | { readonly ok: false; readonly reason: TokenRejection };

/**
 * Prueft einen Token.
 *
 * `session` ist ein Pflichtparameter und darf nicht null sein — die Signatur
 * macht es unmoeglich, den Token allein als Berechtigung zu behandeln. Genau das
 * waere der Fehler, gegen den das ganze Verfahren gebaut ist.
 */
export function checkToken(input: {
  readonly plaintext: string;
  readonly expectedIntentId: string;
  readonly lookup: (tokenHash: string) => StoredToken | null;
  readonly session: { readonly userId: string } | null;
  readonly clock: Clock;
}): TokenCheck {
  if (input.session === null) {
    // Der Token allein reicht nie. Ohne Session gibt es keine Handlung —
    // auch dann nicht, wenn der Token gueltig ist.
    return { ok: false, reason: "NOT_AUTHENTICATED" };
  }

  const hash = hashToken(input.plaintext);
  const stored = input.lookup(hash);
  if (stored === null) return { ok: false, reason: "UNKNOWN_TOKEN" };

  // Vergleich in konstanter Zeit. Der Nutzen ist hier begrenzt, weil bereits
  // ueber den Hash nachgeschlagen wird — aber die Gewohnheit ist richtig, und
  // die naechste Person, die diesen Code anfasst, uebernimmt sie.
  const a = Buffer.from(stored.tokenHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "UNKNOWN_TOKEN" };
  }

  if (stored.consumedAt !== null) return { ok: false, reason: "ALREADY_CONSUMED" };
  if (stored.expiresAt <= input.clock.now()) return { ok: false, reason: "EXPIRED" };
  if (stored.intentId !== input.expectedIntentId) {
    return { ok: false, reason: "INTENT_MISMATCH" };
  }

  return { ok: true, intentId: stored.intentId };
}
