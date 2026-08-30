import type { Logger } from "@sae/observability";
import type { WorkerRole } from "@sae/config";

export interface RoleContext {
  readonly logger: Logger;
  readonly role: WorkerRole;
}

export interface RoleHandler {
  readonly name: WorkerRole;
  start(ctx: RoleContext): Promise<void>;
  stop(): Promise<void>;
}
