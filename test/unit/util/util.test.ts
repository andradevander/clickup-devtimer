import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../../src/util/emitter';
import { SerialQueue } from '../../../src/util/serialQueue';

describe('Emitter', () => {
  it('notifies listeners until they are disposed', () => {
    const emitter = new Emitter<number>();
    const listener = vi.fn();
    const subscription = emitter.event(listener);
    emitter.fire(1);
    subscription.dispose();
    emitter.fire(2);
    expect(listener.mock.calls).toEqual([[1]]);
  });

  it('drops every listener on dispose', () => {
    const emitter = new Emitter<void>();
    const listener = vi.fn();
    emitter.event(listener);
    emitter.dispose();
    emitter.fire();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('SerialQueue', () => {
  it('runs tasks one at a time in order', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    const task = (name: string, delay: number) => () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          log.push(name);
          resolve(name);
        }, delay),
      );
    const results = await Promise.all([
      queue.run(task('a', 20)),
      queue.run(task('b', 0)),
      queue.run(task('c', 5)),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('keeps running after a failure', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(() => Promise.reject(new Error('boom')));
    const next = queue.run(() => Promise.resolve('ok'));
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
