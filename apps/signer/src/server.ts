import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { loadEnv, signerEnvSchema } from "@sae/config";
import { createLogger } from "@sae/observability";
import { PolicyViolation } from "@sae/core";
import { SignerPolicy, type SignRequest } from "./policy";

/**
 * Signier-Dienst.
 *
 * Laeuft in einem eigenen Container OHNE ausgehende Internetverbindung
 * (docker-compose: signing-Netz mit internal: true) und akzeptiert
 * ausschliesslich mTLS-Verbindungen vom Execution-Worker.
 *
 * Phase 1 liefert Transport und Policy vollstaendig; das eigentliche Signieren
 * folgt in Phase 12, wenn die Solana-Bibliothek festgelegt ist. Bis dahin
 * antwortet der Dienst auf eine policy-konforme Anfrage mit 501 — bewusst, statt
 * eine halbe Signierlogik einzubauen, die niemand geprueft hat.
 */

const env = loadEnv(signerEnvSchema, process.env);
const logger = createLogger({ service: "signer", level: env.LOG_LEVEL });

const policy = new SignerPolicy({
  allowedProgramIds: new Set(loadAllowedPrograms()),
  tradingWallet: requireEnv("SIGNER_TRADING_WALLET"),
  allowedDirectRecipients: new Set(
    (process.env["SIGNER_ALLOWED_TIP_ACCOUNTS"] ?? "").split(",").filter(Boolean),
  ),
  maxSolOutPerTxLamports: env.SIGNER_MAX_SOL_OUT_PER_TX_LAMPORTS,
  maxSolOutPerWindowLamports: env.SIGNER_MAX_SOL_OUT_PER_WINDOW_LAMPORTS,
  windowMs: env.SIGNER_WINDOW_SECONDS * 1_000,
});

const server = createServer(
  {
    cert: readFileSync(env.SIGNER_TLS_CERT_PATH),
    key: readFileSync(env.SIGNER_TLS_KEY_PATH),
    ca: readFileSync(env.SIGNER_TLS_CLIENT_CA_PATH),
    // Ohne gueltiges Client-Zertifikat kommt niemand ueberhaupt bis zum Handler.
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  },
  (req, res) => {
    if (req.method !== "POST" || req.url !== "/sign") {
      res.writeHead(404).end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 256_000) req.destroy();
    });

    req.on("end", () => {
      try {
        const request = JSON.parse(body) as SignRequest;
        // Die Intent-Fakten kommen in Phase 12 aus der Datenbank, nicht aus dem
        // Request — der Aufrufer darf die Bedingungen nicht selbst behaupten.
        const intent = { expectedMint: "", stillActive: false };
        policy.check(request, intent, Date.now());

        res.writeHead(501, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Signieren ist erst ab Phase 12 implementiert" }));
      } catch (error) {
        if (error instanceof PolicyViolation) {
          // Grund wird geloggt, aber nicht ausfuehrlich nach aussen gegeben.
          logger.warn({ policy: error.policy, reason: error.message }, "Signatur abgelehnt");
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ policyViolation: error.policy }));
          return;
        }
        logger.error({ err: error }, "Signierfehler");
        res.writeHead(400).end();
      }
    });
  },
);

server.listen(env.SIGNER_PORT, () => {
  logger.info({ role: "signer" }, `Signer laeuft auf Port ${env.SIGNER_PORT}`);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}

function loadAllowedPrograms(): string[] {
  const raw = process.env["SIGNER_ALLOWED_PROGRAM_IDS"];
  if (!raw) throw new Error("Fehlende Umgebungsvariable: SIGNER_ALLOWED_PROGRAM_IDS");
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
