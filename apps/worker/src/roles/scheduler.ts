import type { RoleContext, RoleHandler } from "../role";

/**
 * Rolle: scheduler.
 *
 * Phase-1-Platzhalter. Die Struktur steht (Registrierung, Lifecycle, Logging,
 * Health), die Fachlogik folgt in der jeweiligen Phase. Bewusst leer statt
 * halb implementiert: eine angefangene Handelslogik, die niemand geprueft hat,
 * ist gefaehrlicher als eine offensichtlich fehlende.
 */
export const schedulerRole: RoleHandler = {
  name: "scheduler",
  async start(ctx: RoleContext): Promise<void> {
    ctx.logger.info({ role: "scheduler" }, "Rolle gestartet (Phase-1-Platzhalter, keine Logik)");
  },
  async stop(): Promise<void> {
    // Nichts zu tun, solange keine Verbraucher registriert sind.
  },
};
