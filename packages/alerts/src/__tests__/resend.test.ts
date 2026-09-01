import { describe, expect, it } from "vitest";

import { emailHtml, emailSubject, emailText, type OpportunityEmail } from "../email-template";
import { ResendAdapter, resendFromEnv, type FetchLike } from "../resend";

/**
 * Der Resend-Adapter.
 *
 * Geprueft wird vor allem, was NICHT rausgeht: keine Mail ohne Schluessel,
 * keine Produktionsmail aus einem Test-Fixture, kein Schluessel im Log.
 */

const MAIL: OpportunityEmail = {
  opportunityId: "opp-1",
  tokenSymbol: "WIF",
  mint: "So11111111111111111111111111111111111111112",
  score: 84,
  confidence: 0.72,
  expectedValue: 0.18,
  liquidityUsd: 180_000,
  riskLevel: "LOW",
  suggestedEntryUsd: 0.00042,
  stopUsd: 0.00034,
  takeProfits: [
    { index: 1, targetUsd: 0.000525 },
    { index: 2, targetUsd: 0.00063 },
    { index: 3, targetUsd: 0.00084 },
  ],
  strategyVersion: "1.0.0",
  expiresAt: new Date("2026-08-31T12:05:00Z"),
  confirmUrl: "https://app.example/confirm?token=abc",
  sourceType: "LIVE",
};

function recordingFetch(response: {
  ok?: boolean;
  status?: number;
  body?: string;
}): { fetch: FetchLike; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.body ?? JSON.stringify({ id: "msg-1" }),
    };
  };
  return { fetch, calls };
}

const CONFIGURED = {
  apiKey: "re_test_key_not_real",
  from: "alerts@example.test",
  to: "user@example.test",
  allowTestEmails: false,
};

describe("Resend-Adapter", () => {
  it("sendet eine echte Gelegenheit", async () => {
    const { fetch, calls } = recordingFetch({});
    const result = await new ResendAdapter(CONFIGURED, fetch).send(MAIL);

    expect(result.kind).toBe("SENT");
    if (result.kind === "SENT") expect(result.messageId).toBe("msg-1");
    expect(calls).toHaveLength(1);

    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body["from"]).toBe("alerts@example.test");
    expect(body["subject"]).toBe("WIF — Score 84");
  });

  it("sendet nichts ohne API-Schluessel", async () => {
    const { fetch, calls } = recordingFetch({});
    const result = await new ResendAdapter({ ...CONFIGURED, apiKey: undefined }, fetch).send(MAIL);

    expect(result.kind).toBe("NOT_CONFIGURED");
    // Und zwar wirklich nichts: kein Aufruf mit leerem Header.
    expect(calls).toHaveLength(0);
  });

  it("sendet nichts ohne Absender oder Empfaenger", async () => {
    const { fetch, calls } = recordingFetch({});
    const result = await new ResendAdapter({ ...CONFIGURED, to: undefined }, fetch).send(MAIL);
    expect(result.kind).toBe("NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });

  it("verweigert eine Produktionsmail aus einem Test-Fixture", async () => {
    const { fetch, calls } = recordingFetch({});
    const result = await new ResendAdapter(CONFIGURED, fetch).send({
      ...MAIL,
      sourceType: "TEST_FIXTURE",
    });

    expect(result.kind).toBe("REFUSED");
    if (result.kind === "REFUSED") expect(result.reason).toContain("TEST_FIXTURE");
    expect(calls).toHaveLength(0);
  });

  it("sendet eine Test-Mail nur auf ausdrueckliche Anforderung, sichtbar markiert", async () => {
    const { fetch, calls } = recordingFetch({});
    const result = await new ResendAdapter(
      { ...CONFIGURED, allowTestEmails: true },
      fetch,
    ).send({ ...MAIL, sourceType: "TEST_FIXTURE" });

    expect(result.kind).toBe("SENT");
    const body = JSON.parse(calls[0]!.body) as Record<string, string>;
    expect(body["subject"]).toMatch(/^\[TEST\] /);
    expect(body["text"]).toContain("TEST — diese Mail stammt aus einem Test-Fixture");
    expect(body["html"]).toContain("Keine echte Gelegenheit");
  });

  it("verhindert eine zweite Mail zur selben Gelegenheit", async () => {
    const { fetch, calls } = recordingFetch({});
    await new ResendAdapter(CONFIGURED, fetch).send(MAIL);
    // Der Idempotenzschluessel geht mit — Resend entscheidet, nicht unsere
    // Sorgfalt.
    expect(calls[0]!.headers["idempotency-key"]).toBe("opportunity:opp-1");
  });

  it("meldet einen Fehlschlag, ohne den Schluessel preiszugeben", async () => {
    const { fetch } = recordingFetch({ ok: false, status: 422, body: "invalid to address" });
    const result = await new ResendAdapter(CONFIGURED, fetch).send(MAIL);

    expect(result.kind).toBe("FAILED");
    if (result.kind === "FAILED") {
      expect(result.status).toBe(422);
      expect(result.reason).not.toContain(CONFIGURED.apiKey);
    }
  });

  it("faengt einen Netzfehler ab, statt den Worker mitzureissen", async () => {
    const failing: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await new ResendAdapter(CONFIGURED, failing).send(MAIL);
    expect(result.kind).toBe("FAILED");
  });

  it("baut sich aus der Umgebung und meldet fehlende Konfiguration", () => {
    expect(resendFromEnv({}).configured).toBe(false);
    expect(
      resendFromEnv({
        RESEND_API_KEY: "re_x",
        ALERT_FROM_EMAIL: "a@b.test",
        ALERT_TO_EMAIL: "c@d.test",
      }).configured,
    ).toBe(true);
  });
});

describe("E-Mail-Inhalt", () => {
  it("enthaelt alle geforderten Angaben", () => {
    const text = emailText(MAIL);
    for (const needle of [
      "Score: 84",
      "Konfidenz: 72.0 %",
      "Erwartungswert: 18.0 %",
      "Liquiditaet:",
      "Risiko: LOW",
      "Vorgeschlagener Einstieg:",
      "Stop:",
      "TP1:",
      "TP2:",
      "TP3:",
      "Strategie-Version: 1.0.0",
      "Laeuft ab:",
      "INVEST NOW",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("schreibt 'nicht berechenbar' statt einer Null", () => {
    // Eine Mail, in der EV: 0 steht, weil der Wert fehlte, ist schlimmer als
    // eine, die die Luecke benennt.
    const text = emailText({ ...MAIL, expectedValue: null, score: null, liquidityUsd: null });
    expect(text).toContain("Erwartungswert: nicht berechenbar");
    expect(text).toContain("Score: nicht berechenbar");
    expect(text).not.toContain("Erwartungswert: 0.0 %");
  });

  it("nennt den Alert-Preis nicht als Einstiegspreis", () => {
    expect(emailText(MAIL)).toContain("NICHT der Einstiegspreis");
    expect(emailHtml(MAIL)).toContain("nicht</strong> der Einstiegspreis");
  });

  it("setzt kein TEST-Praefix auf eine echte Gelegenheit", () => {
    expect(emailSubject(MAIL)).not.toContain("[TEST]");
  });

  it("maskiert HTML in Feldern, die von aussen kommen", () => {
    const html = emailHtml({ ...MAIL, tokenSymbol: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
