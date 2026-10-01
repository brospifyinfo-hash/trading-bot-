import { PostgresCheckpointStore, JobQueueRepository, type Database } from "@sae/db";
import type { Logger } from "@sae/observability";

export interface LaunchEvent { mint: string; kind: "create" | "migrate"; signature: string; receivedAt: string }
export function parseLaunchEvent(raw: string, now: Date): LaunchEvent | null {
  if (raw.length > 65536) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.mint !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.mint) ||
        (r.txType !== "create" && r.txType !== "migrate") ||
        typeof r.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(r.signature)) return null;
    return { mint: r.mint, kind: r.txType, signature: r.signature, receivedAt: now.toISOString() };
  } catch { return null; }
}

/** One free event connection; no trade subscriptions, wallet, signer or paid API. */
export function startLaunchFeed(db: Database, logger: Logger): () => Promise<void> {
  const queue = new JobQueueRepository(db), checkpoints = new PostgresCheckpointStore(db);
  const startedAt = new Date();
  let ws: WebSocket | null = null, stopped = false, reconnect: NodeJS.Timeout | undefined;
  let state = "CONNECTING", received = 0, dispatched = 0, dropped = 0, lastEvent: string | null = null;
  let busy = false, backoff = 30_000;
  const pending = new Map<string, LaunchEvent>(), seen = new Set<string>();
  const persist = async () => checkpoints.save({ jobKey: "paper-sniper:feed", startedAt,
    updatedAt: new Date(), doneUnits: [JSON.stringify({ state, received, dispatched, dropped,
      pending: pending.size, lastEvent })], totalUnits: received });
  const connect = () => {
    if (stopped) return;
    state = "CONNECTING";
    ws = new WebSocket("wss://pumpportal.fun/api/data");
    ws.onopen = () => {
      state = "CONNECTED"; backoff = 30_000;
      ws?.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws?.send(JSON.stringify({ method: "subscribeMigration" }));
      logger.info({ role: "paper-sniper" }, "Launch feed connected; free creation/migration subscriptions only");
    };
    ws.onmessage = (message) => {
      if (stopped || typeof message.data !== "string") return;
      const event = parseLaunchEvent(message.data, new Date());
      if (!event || seen.has(event.signature)) return;
      seen.add(event.signature); if (seen.size > 5000) seen.delete(seen.values().next().value!);
      received++; lastEvent = event.receivedAt;
      // Bounded overload handling, visible in dashboard. Pool migrations take priority.
      if (pending.size >= 100 && !pending.has(event.mint)) {
        const disposable = [...pending].find(([, e]) => e.kind === "create");
        if (event.kind === "migrate" && disposable) pending.delete(disposable[0]);
        else { dropped++; return; }
        dropped++;
      }
      const existing = pending.get(event.mint);
      if (!existing || event.kind === "migrate") pending.set(event.mint, event);
    };
    ws.onerror = () => { state = "ERROR"; ws?.close(); };
    ws.onclose = () => {
      if (stopped) return;
      state = "DISCONNECTED";
      reconnect = setTimeout(connect, backoff); reconnect.unref();
      backoff = Math.min(300_000, backoff * 2);
    };
  };
  // Budget four new candidates/minute; event reception is continuous. Avoid a
  // launch flood starving position exits or exceeding the free security quota.
  const timer = setInterval(() => {
    if (busy || stopped) return;
    busy = true;
    void (async () => {
      const now = new Date();
      for (const [mint, e] of pending) if (now.getTime() - Date.parse(e.receivedAt) > 120_000) {
        pending.delete(mint); dropped++;
      }
      const event = [...pending.values()].find((e) => e.kind === "migrate") ?? pending.values().next().value;
      if (event && await queue.countRecentOpen("PAPER_SNIPER", new Date(now.getTime() - 600_000)) < 2) {
        const result = await queue.enqueue({ kind: "PAPER_SNIPER", payload: { ...event, attempt: 0 },
          dedupeKey: `paper-sniper:${event.signature}:0`, at: now, priority: 50 });
        pending.delete(event.mint);
        if (result.kind === "ENQUEUED") dispatched++;
      }
      await persist();
    })().catch(() => logger.warn({ role: "paper-sniper" }, "Launch queue/status write failed"))
      .finally(() => { busy = false; });
  }, 15_000);
  timer.unref(); connect();
  return async () => { stopped = true; clearInterval(timer); if (reconnect) clearTimeout(reconnect);
    ws?.close(); state = "STOPPED"; await persist().catch(() => undefined); };
}
