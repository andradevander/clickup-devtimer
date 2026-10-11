export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window limiter: allows at most `limit` acquisitions per `windowMs`. The server can also
 * block it until a given time (e.g. after an HTTP 429).
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private blockedUntil = 0;

  constructor(
    private readonly limit = 100,
    private readonly windowMs = 60_000,
    private readonly clock: Clock = Date.now,
    private readonly sleep: Sleep = defaultSleep,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock();
      while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) <= now - this.windowMs) {
        this.timestamps.shift();
      }
      if (now < this.blockedUntil) {
        await this.sleep(this.blockedUntil - now);
        continue;
      }
      const oldest = this.timestamps[0];
      if (this.timestamps.length < this.limit || oldest === undefined) {
        this.timestamps.push(now);
        return;
      }
      await this.sleep(oldest + this.windowMs - now);
    }
  }

  blockUntil(timestamp: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, timestamp);
  }
}
