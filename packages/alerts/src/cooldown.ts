import type { Clock } from "@sae/core";

/**
 * Alert-Deduplizierung.
 *
 * Zwanzig Mails zum selben Token machen aus einem nuetzlichen System eines, das
 * man stummschaltet — und dann ist auch der eine wichtige Alert weg. Der
 * Cooldown ist deshalb kein Komfortmerkmal, sondern die Voraussetzung dafuer,
 * dass Alerts ueberhaupt gelesen werden.
 *
 * Ausnahme mit Absicht: steigt der Score deutlich, ist das eine neue Information
 * und kein Wiederholung. Die Schwelle ist konfigurierbar.
 */

export interface AlertRecord {
  readonly dedupKey: string;
  readonly sentAt: Date;
  readonly finalScore: number;
}

export type AlertDecision =
  | { readonly send: true; readonly reason: "FIRST_ALERT" | "SCORE_JUMP" }
  | {
      readonly send: false;
      readonly reason: "WITHIN_COOLDOWN";
      readonly cooldownEndsAt: Date;
    };

export function shouldSendAlert(input: {
  readonly dedupKey: string;
  readonly finalScore: number;
  readonly history: readonly AlertRecord[];
  readonly cooldownSeconds: number;
  readonly scoreJumpThreshold: number;
  readonly clock: Clock;
}): AlertDecision {
  const now = input.clock.now();
  const previous = input.history
    .filter((a) => a.dedupKey === input.dedupKey)
    .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];

  if (previous === undefined) return { send: true, reason: "FIRST_ALERT" };

  const cooldownEndsAt = new Date(previous.sentAt.getTime() + input.cooldownSeconds * 1_000);
  if (now >= cooldownEndsAt) return { send: true, reason: "FIRST_ALERT" };

  // Nur ein deutlicher Anstieg rechtfertigt eine erneute Mail. Ein Ruecklauf
  // oder eine Seitwaertsbewegung ist keine neue Information.
  if (input.finalScore - previous.finalScore >= input.scoreJumpThreshold) {
    return { send: true, reason: "SCORE_JUMP" };
  }

  return { send: false, reason: "WITHIN_COOLDOWN", cooldownEndsAt };
}
