import { describe, expect, it } from "vitest";

import { checkWebEnv } from "../readiness";

/**
 * Der Zustand, in dem sich eine frisch deployte Instanz befindet.
 *
 * Anlass war ein echter Ausfall: die Produktions-URL antwortete mit
 * „Application error: a server-side exception has occurred". Ursache war ein
 * Wurf beim Validieren der Umgebung in einer Server-Komponente ohne
 * Fehlergrenze. Geprueft wird hier, dass der Zustand jetzt benennbar ist —
 * und dass die Namen der fehlenden Variablen herauskommen, aber nie deren Werte.
 */

const VOLLSTAENDIG = {
  DATABASE_URL: "postgres://user:geheim@host:5432/db",
  SESSION_SECRET: "x".repeat(32),
  APP_BASE_URL: "https://example.com",
} as const;

describe("Vollstaendige Konfiguration", () => {
  it("meldet READY", () => {
    expect(checkWebEnv(VOLLSTAENDIG).kind).toBe("READY");
  });

  it("stoert sich nicht an zusaetzlichen Variablen", () => {
    expect(checkWebEnv({ ...VOLLSTAENDIG, IRGENDWAS: "egal" }).kind).toBe("READY");
  });
});

describe("Unvollstaendige Konfiguration", () => {
  it("nennt jede fehlende Variable beim Namen", () => {
    const result = checkWebEnv({});
    expect(result.kind).toBe("ENV_INCOMPLETE");
    if (result.kind !== "ENV_INCOMPLETE") return;

    const namen = result.problems.map((p) => p.variable).sort();
    expect(namen).toEqual(["APP_BASE_URL", "DATABASE_URL", "SESSION_SECRET"]);
  });

  it("erkennt ein zu kurzes SESSION_SECRET", () => {
    const result = checkWebEnv({ ...VOLLSTAENDIG, SESSION_SECRET: "zu-kurz" });
    expect(result.kind).toBe("ENV_INCOMPLETE");
    if (result.kind !== "ENV_INCOMPLETE") return;
    expect(result.problems.map((p) => p.variable)).toEqual(["SESSION_SECRET"]);
  });

  it("erkennt eine unbrauchbare DATABASE_URL", () => {
    const result = checkWebEnv({ ...VOLLSTAENDIG, DATABASE_URL: "kein-url" });
    expect(result.kind).toBe("ENV_INCOMPLETE");
    if (result.kind !== "ENV_INCOMPLETE") return;
    expect(result.problems.map((p) => p.variable)).toEqual(["DATABASE_URL"]);
  });

  it("gibt niemals einen Wert preis", () => {
    // Der eigentliche Grund fuer diesen Test: die Ausgabe landet in einer
    // oeffentlich erreichbaren Oberflaeche.
    const result = checkWebEnv({
      DATABASE_URL: "postgres://user:SUPERGEHEIM@host:5432/db",
      SESSION_SECRET: "zu-kurz-aber-geheim",
      APP_BASE_URL: "nicht-wirklich-eine-url",
    });
    expect(result.kind).toBe("ENV_INCOMPLETE");
    if (result.kind !== "ENV_INCOMPLETE") return;

    const alles = JSON.stringify(result);
    expect(alles).not.toContain("SUPERGEHEIM");
    expect(alles).not.toContain("zu-kurz-aber-geheim");
    expect(alles).not.toContain("nicht-wirklich-eine-url");
  });
});
