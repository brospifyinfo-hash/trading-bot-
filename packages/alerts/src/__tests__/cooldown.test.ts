import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import { shouldSendAlert, type AlertRecord } from "../cooldown";

const T0 = new Date("2026-08-30T12:00:00Z");
const base = {
  dedupKey: "token-1",
  cooldownSeconds: 1_800,
  scoreJumpThreshold: 8,
};

describe("shouldSendAlert", () => {
  it("sendet den ersten Alert", () => {
    const result = shouldSendAlert({
      ...base,
      finalScore: 82,
      history: [],
      clock: new FixedClock(T0),
    });
    expect(result.send).toBe(true);
  });

  it("unterdrueckt eine Wiederholung im Cooldown", () => {
    // Zwanzig Mails zum selben Token machen aus einem nuetzlichen System eines,
    // das man stummschaltet — und dann fehlt auch der eine wichtige Alert.
    const history: AlertRecord[] = [{ dedupKey: "token-1", sentAt: T0, finalScore: 82 }];
    const clock = new FixedClock(new Date(T0.getTime() + 600_000));
    const result = shouldSendAlert({ ...base, finalScore: 83, history, clock });
    expect(result.send).toBe(false);
    if (!result.send) expect(result.cooldownEndsAt.getTime()).toBe(T0.getTime() + 1_800_000);
  });

  it("sendet nach Ablauf des Cooldowns wieder", () => {
    const history: AlertRecord[] = [{ dedupKey: "token-1", sentAt: T0, finalScore: 82 }];
    const clock = new FixedClock(new Date(T0.getTime() + 1_800_001));
    expect(shouldSendAlert({ ...base, finalScore: 80, history, clock }).send).toBe(true);
  });

  it("sendet bei deutlichem Score-Anstieg trotz Cooldown", () => {
    const history: AlertRecord[] = [{ dedupKey: "token-1", sentAt: T0, finalScore: 78 }];
    const clock = new FixedClock(new Date(T0.getTime() + 300_000));
    const result = shouldSendAlert({ ...base, finalScore: 90, history, clock });
    expect(result.send).toBe(true);
    if (result.send) expect(result.reason).toBe("SCORE_JUMP");
  });

  it("sendet NICHT bei fallendem Score im Cooldown", () => {
    // Ein Ruecklauf ist keine neue Information.
    const history: AlertRecord[] = [{ dedupKey: "token-1", sentAt: T0, finalScore: 90 }];
    const clock = new FixedClock(new Date(T0.getTime() + 300_000));
    expect(shouldSendAlert({ ...base, finalScore: 75, history, clock }).send).toBe(false);
  });

  it("trennt verschiedene Tokens", () => {
    const history: AlertRecord[] = [{ dedupKey: "token-1", sentAt: T0, finalScore: 82 }];
    const clock = new FixedClock(new Date(T0.getTime() + 60_000));
    expect(
      shouldSendAlert({ ...base, dedupKey: "token-2", finalScore: 80, history, clock }).send,
    ).toBe(true);
  });

  it("nimmt den juengsten Eintrag als Bezug", () => {
    const history: AlertRecord[] = [
      { dedupKey: "token-1", sentAt: new Date(T0.getTime() - 7_200_000), finalScore: 60 },
      { dedupKey: "token-1", sentAt: T0, finalScore: 88 },
    ];
    const clock = new FixedClock(new Date(T0.getTime() + 60_000));
    expect(shouldSendAlert({ ...base, finalScore: 89, history, clock }).send).toBe(false);
  });
});
