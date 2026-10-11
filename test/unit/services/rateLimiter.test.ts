import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/services/rateLimiter';

/** A fake clock whose sleep advances time instantly. */
function fakeTime(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
    get now() {
      return now;
    },
  };
}

describe('RateLimiter', () => {
  it('allows up to the limit without waiting', async () => {
    const time = fakeTime();
    const limiter = new RateLimiter(3, 1000, time.clock, time.sleep);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(time.sleeps).toEqual([]);
  });

  it('waits for the oldest call to leave the window', async () => {
    const time = fakeTime();
    const limiter = new RateLimiter(2, 1000, time.clock, time.sleep);
    await limiter.acquire();
    time.advance(300);
    await limiter.acquire();
    await limiter.acquire();
    expect(time.sleeps).toEqual([700]);
  });

  it('frees slots as time passes', async () => {
    const time = fakeTime();
    const limiter = new RateLimiter(1, 1000, time.clock, time.sleep);
    await limiter.acquire();
    time.advance(1000);
    await limiter.acquire();
    expect(time.sleeps).toEqual([]);
  });

  it('waits while blocked', async () => {
    const time = fakeTime();
    const limiter = new RateLimiter(10, 1000, time.clock, time.sleep);
    limiter.blockUntil(time.now + 5000);
    limiter.blockUntil(time.now + 1000); // an earlier block does not shorten the wait
    await limiter.acquire();
    expect(time.sleeps).toEqual([5000]);
  });
});
