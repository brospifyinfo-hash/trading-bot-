/** One budget for market probes and paper execution in this worker process. */
export class JupiterRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private nextAt = 0;
  constructor(private readonly now = Date.now,
    private readonly sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {}
  acquire(): Promise<void> {
    const turn = this.tail.then(async () => {
      while (this.nextAt > this.now()) await this.sleep(this.nextAt - this.now());
      this.nextAt = this.now() + 2000;
    });
    this.tail = turn.catch(() => {});
    return turn;
  }
  rateLimited(): void { this.nextAt = Math.max(this.nextAt, this.now() + 8000); }
}
const gates = new Map<string, JupiterRequestGate>();
export function jupiterRequestGate(baseUrl: string): JupiterRequestGate {
  const key = new URL(baseUrl).origin;
  let gate = gates.get(key);
  if (!gate) { gate = new JupiterRequestGate(); gates.set(key, gate); }
  return gate;
}
