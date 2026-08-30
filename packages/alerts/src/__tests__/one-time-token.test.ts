import { describe, expect, it } from "vitest";
import { FixedClock } from "@sae/core";
import {
  DEFAULT_TTL_MS,
  TOKEN_BYTES,
  checkToken,
  hashToken,
  issueToken,
  type StoredToken,
} from "../one-time-token";

const T0 = new Date("2026-08-30T12:00:00Z");
const session = { userId: "user-1" };

const lookupOf = (stored: StoredToken) => (hash: string) =>
  hash === stored.tokenHash ? stored : null;

describe("issueToken", () => {
  it("speichert nur den Hash, nie den Klartext", () => {
    // Wer die Datenbank liest, darf keinen Trade ausloesen koennen.
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    expect(issued.stored).not.toHaveProperty("plaintext");
    expect(JSON.stringify(issued.stored)).not.toContain(issued.plaintext);
    expect(issued.stored.tokenHash).toBe(hashToken(issued.plaintext));
  });

  it("erzeugt bei jedem Aufruf einen anderen Token", () => {
    const clock = new FixedClock(T0);
    const a = issueToken("intent-1", clock);
    const b = issueToken("intent-1", clock);
    expect(a.plaintext).not.toBe(b.plaintext);
  });

  it("nutzt ausreichend Entropie", () => {
    const issued = issueToken("intent-1", new FixedClock(T0));
    // base64url von 32 Byte: 43 Zeichen ohne Fuellzeichen.
    expect(issued.plaintext.length).toBeGreaterThanOrEqual(TOKEN_BYTES);
    expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("setzt eine kurze Gueltigkeit", () => {
    const issued = issueToken("intent-1", new FixedClock(T0));
    expect(issued.stored.expiresAt.getTime() - T0.getTime()).toBe(DEFAULT_TTL_MS);
  });
});

describe("checkToken", () => {
  it("akzeptiert einen gueltigen Token mit Session", () => {
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-1",
      lookup: lookupOf(issued.stored),
      session,
      clock,
    });
    expect(result).toEqual({ ok: true, intentId: "intent-1" });
  });

  it("lehnt einen gueltigen Token OHNE Session ab", () => {
    // Der entscheidende Test: der Token identifiziert einen Intent, er
    // autorisiert nichts. Wer die Mail abfaengt, kommt damit nicht weiter.
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-1",
      lookup: lookupOf(issued.stored),
      session: null,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "NOT_AUTHENTICATED" });
  });

  it("lehnt einen unbekannten Token ab", () => {
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    const result = checkToken({
      plaintext: "voellig-erfunden",
      expectedIntentId: "intent-1",
      lookup: lookupOf(issued.stored),
      session,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "UNKNOWN_TOKEN" });
  });

  it("lehnt einen bereits benutzten Token ab", () => {
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    const consumed = { ...issued.stored, consumedAt: T0 };
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-1",
      lookup: lookupOf(consumed),
      session,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "ALREADY_CONSUMED" });
  });

  it("lehnt einen abgelaufenen Token ab", () => {
    // Ein alter Link aus dem Postfach darf nichts mehr ausloesen.
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    clock.advance(DEFAULT_TTL_MS + 1_000);
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-1",
      lookup: lookupOf(issued.stored),
      session,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("lehnt einen Token fuer einen anderen Intent ab", () => {
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-2",
      lookup: lookupOf(issued.stored),
      session,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "INTENT_MISMATCH" });
  });

  it("prueft die Session vor allem anderen", () => {
    // Ohne Session gibt es keine Handlung — auch dann nicht, wenn der Token
    // ausserdem abgelaufen waere. Die Reihenfolge verraet auch nichts darueber,
    // ob der Token existiert.
    const clock = new FixedClock(T0);
    const issued = issueToken("intent-1", clock);
    clock.advance(DEFAULT_TTL_MS + 1_000);
    const result = checkToken({
      plaintext: issued.plaintext,
      expectedIntentId: "intent-1",
      lookup: lookupOf(issued.stored),
      session: null,
      clock,
    });
    expect(result).toEqual({ ok: false, reason: "NOT_AUTHENTICATED" });
  });
});
