import { describe, it, expect, vi } from "vitest";
import { JupiterRequestGate, jupiterRequestGate } from "../jupiter-request-gate";
describe("shared Jupiter budget", () => {
  it("spaces concurrent callers and respects a rate-limit cooldown", async () => {
    vi.useFakeTimers();
    try {
      const gate = new JupiterRequestGate();
      const starts: number[] = [];
      const start = Date.now();
      const requests = [1, 2, 3].map(async () => { await gate.acquire(); starts.push(Date.now() - start); });
      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toEqual([0]);
      gate.rateLimited();
      await vi.advanceTimersByTimeAsync(7999);
      expect(starts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(2001);
      await Promise.all(requests);
      expect(starts).toEqual([0, 8000, 10000]);
    } finally { vi.useRealTimers(); }
  });
  it("shares the same origin across quote consumers", () => {
    expect(jupiterRequestGate("https://example.test/swap/v1")).toBe(jupiterRequestGate("https://example.test/quote"));
  });
});
