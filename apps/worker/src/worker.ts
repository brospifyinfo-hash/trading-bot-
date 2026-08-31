import { loadEnv, workerEnvSchema, type WorkerRole } from "@sae/config";
import { createLogger } from "@sae/observability";
import { Lifecycle } from "./lifecycle";
import { startHealthServer } from "./health";
import type { RoleHandler } from "./role";
import { discoveryRole } from "./roles/discovery";
import { enrichmentRole } from "./roles/enrichment";
import { scoringRole } from "./roles/scoring";
import { decisionRole } from "./roles/decision";
import { executionRole } from "./roles/execution";
import { positionsRole } from "./roles/positions";
import { paperRole } from "./roles/paper";
import { reconcilerRole } from "./roles/reconciler";
import { alertsRole } from "./roles/alerts";
import { schedulerRole } from "./roles/scheduler";
import { providerHealthRole } from "./roles/provider-health";

/**
 * Rollenbasierter Einstiegspunkt.
 *
 * Ein Image, viele Container: die Rolle kommt aus WORKER_ROLE. Das haelt die
 * Deploy-Matrix klein und garantiert, dass alle Rollen denselben Code teilen —
 * getrennte Images driften auseinander.
 */

const ROLES: Record<WorkerRole, RoleHandler> = {
  discovery: discoveryRole,
  enrichment: enrichmentRole,
  scoring: scoringRole,
  decision: decisionRole,
  execution: executionRole,
  positions: positionsRole,
  paper: paperRole,
  reconciler: reconcilerRole,
  alerts: alertsRole,
  scheduler: schedulerRole,
  "provider-health": providerHealthRole,
};

async function main(): Promise<void> {
  const env = loadEnv(workerEnvSchema, process.env);
  const logger = createLogger({ service: `worker:${env.WORKER_ROLE}`, level: env.LOG_LEVEL });
  const lifecycle = new Lifecycle(logger);
  lifecycle.install();

  const role: RoleHandler | undefined = ROLES[env.WORKER_ROLE];
  if (!role) {
    // Kann nur passieren, wenn WORKER_ROLES und ROLES auseinanderlaufen.
    // Sichtbar scheitern ist hier richtig: ein Worker ohne Rolle ist ein Prozess,
    // der Ressourcen haelt und nichts tut.
    throw new Error(`Keine Implementierung fuer Rolle ${env.WORKER_ROLE}`);
  }
  await role.start({ logger, role: env.WORKER_ROLE });

  const health = startHealthServer({
    // Betriebsparameter, kein Handelsinput: ein Standard-Port beeinflusst keine
    // Entscheidung.
    // eslint-disable-next-line sae/no-numeric-fallback
    port: Number(process.env["HEALTH_PORT"] ?? 3001),
    isReady: () => !lifecycle.shuttingDown,
  });

  lifecycle.onShutdown(async () => {
    await role.stop();
    await new Promise<void>((resolve) => health.close(() => resolve()));
  });
}

main().catch((error: unknown) => {
  // Startfehler sind fatal: lieber sichtbar nicht starten als halb laufen.
  console.error(error);
  process.exit(1);
});
