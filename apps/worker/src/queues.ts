import type { JobsOptions } from "bullmq";

/**
 * Queue-Definitionen.
 *
 * Die Retry-Politik ist pro Queue unterschiedlich, und zwar aus einem Grund:
 * ein wiederholter Discovery-Job kostet nichts, ein wiederholter Execution-Job
 * kann eine Position verdoppeln. Deshalb hat `execution` genau einen Versuch —
 * Wiederholungen entscheidet dort ausschliesslich der Reconciler, nachdem er
 * den tatsaechlichen Zustand auf der Chain festgestellt hat.
 */

export const QUEUES = {
  discovery: "discovery",
  screening: "screening",
  enrichment: "enrichment",
  scoring: "scoring",
  decision: "decision",
  execution: "execution",
  positions: "positions",
  paper: "paper",
  reconciler: "reconciler",
  alerts: "alerts",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  discovery: { source: string };
  screening: { tokenId: string };
  enrichment: { tokenId: string; traceId: string };
  scoring: { tokenId: string; traceId: string };
  decision: { tokenId: string; traceId: string };
  execution: { intentId: string; traceId: string };
  positions: { positionId: string };
  paper: { intentId: string; traceId: string };
  reconciler: { positionId?: string };
  alerts: { alertId: string };
}

export const QUEUE_OPTIONS: Record<QueueName, JobsOptions> = {
  discovery: { attempts: 3, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 500 },
  screening: { attempts: 3, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 500 },
  enrichment: { attempts: 3, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 500 },
  scoring: { attempts: 2, backoff: { type: "fixed", delay: 1_000 }, removeOnComplete: 500 },
  decision: { attempts: 1, removeOnComplete: 1_000 },
  // Genau ein Versuch. Ein automatischer Retry auf einer gesendeten Transaktion
  // ist der direkte Weg zur doppelten Position.
  execution: { attempts: 1, removeOnComplete: false, removeOnFail: false },
  positions: { attempts: 2, backoff: { type: "fixed", delay: 500 } },
  paper: { attempts: 2, backoff: { type: "fixed", delay: 500 } },
  reconciler: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  alerts: { attempts: 4, backoff: { type: "exponential", delay: 10_000 } },
};

/** Wie viele Jobs eine Rolle gleichzeitig bearbeiten darf. */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  discovery: 1,
  screening: 4,
  enrichment: 4,
  scoring: 2,
  decision: 1,
  // Singleton: nebenlaeufige Ausfuehrung auf demselben Mint ist strukturell
  // ausgeschlossen, nicht nur durch Locks abgesichert.
  execution: 1,
  positions: 1,
  paper: 2,
  reconciler: 1,
  alerts: 2,
};
