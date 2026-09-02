import { describe, expect, it } from "vitest";

import { assertNotServerless, detectServerlessPlatform } from "../runtime";

/**
 * Die Deploy-Grenze als Test.
 *
 * Anlass war ein echtes Fehldeployment: ein Vercel-Projekt zeigte auf
 * `apps/signer`. Der Signer scheiterte dort zwar, aber mit der Meldung
 * „SIGNER_KEY_FILE: Required" — und die liest sich wie eine Aufforderung, die
 * Variablen nachzutragen. Genau das waere die gefaehrlichste Reaktion gewesen:
 * die Konfiguration des schluesselhaltenden Dienstes auf eine oeffentlich
 * erreichbare Plattform zu legen.
 *
 * Geprueft wird deshalb beides: dass die Erkennung greift, und dass die
 * Meldung in die richtige Richtung zeigt.
 */

const GUARD = {
  component: "Der Signer",
  reason: "Er haelt den privaten Schluessel.",
  belongsOn: "einen eigenen Host",
} as const;

describe("Erkennung der Plattform", () => {
  it("erkennt Vercel an VERCEL", () => {
    expect(detectServerlessPlatform({ VERCEL: "1" })).toBe("Vercel");
  });

  it("erkennt Vercel auch nur an VERCEL_ENV", () => {
    expect(detectServerlessPlatform({ VERCEL_ENV: "production" })).toBe("Vercel");
  });

  it("erkennt AWS Lambda", () => {
    expect(detectServerlessPlatform({ AWS_LAMBDA_FUNCTION_NAME: "f" })).toBe("AWS Lambda");
  });

  it("haelt einen gewoehnlichen Prozess fuer gewoehnlich", () => {
    // Railway, Docker und die eigene Maschine setzen nichts davon.
    expect(detectServerlessPlatform({ DATABASE_URL: "postgres://x", PORT: "3001" })).toBeNull();
  });

  it("laesst sich von einem leeren Wert nicht taeuschen", () => {
    expect(detectServerlessPlatform({ VERCEL: "" })).toBeNull();
  });
});

describe("Der Abbruch", () => {
  it("laesst einen gewoehnlichen Prozess durch", () => {
    expect(() => assertNotServerless({ ...GUARD, env: {} })).not.toThrow();
  });

  it("bricht auf Vercel ab", () => {
    expect(() => assertNotServerless({ ...GUARD, env: { VERCEL: "1" } })).toThrow(/Vercel/);
  });

  it("nennt die Komponente und wohin sie gehoert", () => {
    try {
      assertNotServerless({ ...GUARD, env: { VERCEL: "1" } });
      throw new Error("haette abbrechen muessen");
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain("Der Signer");
      expect(message).toContain("einen eigenen Host");
      expect(message).toContain("Er haelt den privaten Schluessel.");
    }
  });

  it("sagt ausdruecklich, dass Variablen nachtragen der falsche Weg ist", () => {
    // Das ist der eigentliche Zweck der Meldung. Ohne diesen Satz fuehrt die
    // urspruengliche Fehlermeldung geradewegs zur gefaehrlichen Abhilfe.
    try {
      assertNotServerless({ ...GUARD, env: { VERCEL: "1" } });
      throw new Error("haette abbrechen muessen");
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain("KEINE fehlende Konfiguration");
      expect(message).toMatch(/Projekt entfernen/);
    }
  });
});
