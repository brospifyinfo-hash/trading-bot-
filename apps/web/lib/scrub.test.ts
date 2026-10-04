import { describe, expect, it } from "vitest";

import { scrubFehlertext } from "./scrub";

describe("scrubFehlertext", () => {
  it("entfernt Zugangsdaten aus einer Verbindungszeichenfolge", () => {
    const t = scrubFehlertext(
      "error: connection to postgres://neondb_owner:npg_GEHEIM123@ep-x.eu-central-1.aws.neon.tech/neondb failed",
    );
    expect(t).not.toContain("npg_GEHEIM123");
    expect(t).not.toContain("neondb_owner");
    // Der Host bleibt lesbar — er ist der diagnostische Teil.
    expect(t).toContain("ep-x.eu-central-1.aws.neon.tech");
    expect(t).toContain("[zugangsdaten entfernt]");
  });

  it("entfernt benannte Geheimnisse, egal in welcher Schreibweise", () => {
    for (const roh of [
      "request failed: api_key=sk-live-abc123def456",
      "request failed: apiKey: 'sk-live-abc123def456'",
      "headers {authorization: Bearer sk-live-abc123def456}",
      "DB_PASSWORD=hunter2 not accepted",
      "X-API-KEY: sk-live-abc123def456",
    ]) {
      const t = scrubFehlertext(roh);
      expect(t).not.toContain("sk-live-abc123def456");
      expect(t).not.toContain("hunter2");
    }
  });

  it("entfernt JWTs und lange Hex-Schluessel", () => {
    expect(scrubFehlertext("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl"))
      .toContain("[jwt entfernt]");
    expect(scrubFehlertext(`key ${"a1b2c3d4".repeat(8)} invalid`)).toContain("[hex entfernt]");
  });

  it("laesst den eigentlichen Fehler stehen — sonst waere die Anzeige wertlos", () => {
    const t = scrubFehlertext("QUOTE_RATE_LIMIT: jupiter antwortete mit 429 nach 3 Versuchen");
    expect(t).toBe("QUOTE_RATE_LIMIT: jupiter antwortete mit 429 nach 3 Versuchen");
  });

  it("laesst eine Mint-Adresse stehen", () => {
    // Base58, keine lange Hex-Kette: das ist der Token, um den es geht, und
    // ohne ihn ist die Fehlermeldung nicht nachvollziehbar.
    const mint = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    expect(scrubFehlertext(`no route for ${mint}`)).toContain(mint);
  });

  it("kuerzt und raeumt Steuerzeichen weg", () => {
    const lang = scrubFehlertext(`Fehler ${"x".repeat(900)}`);
    expect(lang).not.toBeNull();
    expect((lang ?? "").length).toBeLessThanOrEqual(410);
    expect(lang).toMatch(/…$/);
    expect(scrubFehlertext("zeile1\r\nzeile2")).toBe("zeile1 zeile2");
  });

  it("gibt null zurueck, wo es nichts anzuzeigen gibt", () => {
    expect(scrubFehlertext(null)).toBeNull();
    expect(scrubFehlertext("   ")).toBeNull();
  });
});
