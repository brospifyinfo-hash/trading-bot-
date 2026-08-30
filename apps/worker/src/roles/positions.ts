import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: positions.
 *
 * Phase-1-Platzhalter. Die Struktur steht (Registrierung, Lifecycle, Logging,
 * Health), die Fachlogik folgt in der jeweiligen Phase. Bewusst leer statt
 * halb implementiert: eine angefangene Handelslogik, die niemand geprueft hat,
 * ist gefaehrlicher als eine offensichtlich fehlende.
 */
export const positionsRole: RoleHandler = {
  name: "positions",
  async start(ctx: RoleContext): Promise<void> {
    ctx.logger.info({ role: "positions" }, "Rolle gestartet (Phase-1-Platzhalter, keine Logik)");
  },
  async stop(): Promise<void> {
    // Nichts zu tun, solange keine Verbraucher registriert sind.
  },
};
