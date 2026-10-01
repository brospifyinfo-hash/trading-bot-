import { expect, it } from "vitest";
import { parseLaunchEvent } from "../feed";
const now = new Date("2026-09-29T12:00:00Z");
const event = { mint: "6qfkAEjeBZMXcV2HTp8kaCTLwa4djz5KcUoEigEjpump", txType: "migrate",
  signature: "46himmXF7TsKA4VfXYB5uD1azbtfS9BZRG7RvvyS7QzK5Kb5nFT3t4TUnf3dUttB4maoBqYqs5RndbZ8FSkH29os" };
it("accepts the observed migration schema and uses receive time", () => {
  expect(parseLaunchEvent(JSON.stringify(event), now)).toEqual({ mint: event.mint, kind: "migrate", signature: event.signature, receivedAt: now.toISOString() });
});
it("rejects acknowledgments, trades, malformed payloads and invalid addresses", () => {
  for (const raw of ["null", "{", JSON.stringify({message:"subscribed"}), JSON.stringify({...event,txType:"buy"}), JSON.stringify({...event,mint:"invalid"})]) expect(parseLaunchEvent(raw, now)).toBeNull();
});

it("wires validated feed events into the durable sniper queue once, never paid trade subscriptions", async () => {
  const { vi } = await import("vitest");
  const { JobQueueRepository, PostgresCheckpointStore } = await import("@sae/db");
  const { createLogger } = await import("@sae/observability");
  const { startLaunchFeed } = await import("../feed");
  class Socket {
    static instance: Socket;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn(); close = vi.fn();
    constructor() { Socket.instance = this; }
  }
  const openCount = vi.spyOn(JobQueueRepository.prototype, "countRecentOpen").mockResolvedValue(2);
  const enqueue = vi.spyOn(JobQueueRepository.prototype, "enqueue").mockResolvedValue({ kind: "ENQUEUED", jobId: "test" });
  vi.spyOn(PostgresCheckpointStore.prototype, "save").mockResolvedValue();
  vi.useFakeTimers(); vi.setSystemTime(now); vi.stubGlobal("WebSocket", Socket);
  const stop = startLaunchFeed({} as never, createLogger({ service: "test", level: "error" }));
  try {
    Socket.instance.onopen?.();
    expect(Socket.instance.send.mock.calls.map(([r]) => JSON.parse(r).method)).toEqual(["subscribeNewToken", "subscribeMigration"]);
    Socket.instance.onmessage?.({ data: JSON.stringify(event) });
    Socket.instance.onmessage?.({ data: JSON.stringify(event) });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(enqueue).not.toHaveBeenCalled();
    openCount.mockResolvedValue(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: "PAPER_SNIPER",
      payload: expect.objectContaining({ mint: event.mint, kind: "migrate", signature: event.signature }) }));
  } finally { await stop(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});
