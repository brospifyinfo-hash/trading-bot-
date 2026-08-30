import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: discovery.
 *
 * Phase-1-Platzhalter. Die Struktur steht (Registrierung, Lifecycle, Logging,
 * Health), die Fachlogik folgt in der jeweiligen Phase. Bewusst leer statt
 * halb implementiert: eine angefangene Handelslogik, die niemand geprueft hat,
 * ist gefaehrlicher als eine offensichtlich fehlende.
 */
export const discoveryRole: RoleHandler = {
  name: "discovery",
  async start(ctx: RoleContext): Promise<void> {
    ctx.logger.info({ role: "discovery" }, "Rolle gestartet (Phase-1-Platzhalter, keine Logik)");
  },
  async stop(): Promise<void> {
    // Nichts zu tun, solange keine Verbraucher registriert sind.
  },
};
