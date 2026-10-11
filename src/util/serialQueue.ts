/**
 * Runs async tasks one at a time, in submission order. Used so that read-modify-write cycles on the
 * same file from one window never interleave.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
