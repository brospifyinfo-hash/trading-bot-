import { describe, expect, it } from "vitest";
import { loadEnv, signerEnvSchema, workerEnvSchema } from "../env";

const validWorkerEnv = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/sae",
  REDIS_URL: "redis://localhost:6379",
  WORKER_ROLE: "scoring",
  SOLANA_RPC_URL: "https://rpc.example.com",
};

describe("loadEnv", () => {
  it("akzeptiert eine vollstaendige Konfiguration", () => {
    const env = loadEnv(workerEnvSchema, validWorkerEnv as NodeJS.ProcessEnv);
    expect(env.WORKER_ROLE).toBe("scoring");
    expect(env.NODE_ENV).toBe("development");
  });

  it("wirft, wenn eine Pflichtvariable fehlt", () => {
    const { SOLANA_RPC_URL: _omitted, ...incomplete } = validWorkerEnv;
    expect(() => loadEnv(workerEnvSchema, incomplete as NodeJS.ProcessEnv)).toThrow(
      /SOLANA_RPC_URL/,
    );
  });

  it("wirft bei einer unbekannten Worker-Rolle", () => {
    expect(() =>
      loadEnv(workerEnvSchema, { ...validWorkerEnv, WORKER_ROLE: "trading" } as NodeJS.ProcessEnv),
    ).toThrow(/WORKER_ROLE/);
  });

  it("nennt in der Fehlermeldung nie den Wert der Variablen", () => {
    // Ein falsch gesetztes Geheimnis darf durch die Validierung nicht ins Log geraten.
    const secret = "postgres://user:SUPER_GEHEIM@host/db_aber_keine_url";
    try {
      loadEnv(workerEnvSchema, { ...validWorkerEnv, DATABASE_URL: "keine-url" } as NodeJS.ProcessEnv);
      expect.unreachable("haette werfen muessen");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("SUPER_GEHEIM");
      expect(String(error)).toContain("DATABASE_URL");
    }
  });
});

describe("Signer-Konfiguration", () => {
  it("verlangt Schluesseldatei und Abflussgrenzen", () => {
    expect(() =>
      loadEnv(signerEnvSchema, {
        SIGNER_KEY_FILE: "/run/secrets/signer_key",
        SIGNER_TLS_CERT_PATH: "/run/secrets/tls.crt",
        SIGNER_TLS_KEY_PATH: "/run/secrets/tls.key",
        SIGNER_TLS_CLIENT_CA_PATH: "/run/secrets/ca.crt",
        SIGNER_MAX_SOL_OUT_PER_TX_LAMPORTS: "500000000",
        SIGNER_MAX_SOL_OUT_PER_WINDOW_LAMPORTS: "2000000000",
      } as unknown as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("wirft, wenn die Abflussgrenze fehlt", () => {
    expect(() =>
      loadEnv(signerEnvSchema, {
        SIGNER_KEY_FILE: "/run/secrets/signer_key",
        SIGNER_TLS_CERT_PATH: "/run/secrets/tls.crt",
        SIGNER_TLS_KEY_PATH: "/run/secrets/tls.key",
        SIGNER_TLS_CLIENT_CA_PATH: "/run/secrets/ca.crt",
      } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/SIGNER_MAX_SOL_OUT_PER_TX_LAMPORTS/);
  });
});
