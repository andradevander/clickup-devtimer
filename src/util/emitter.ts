export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (event: T) => void) => Disposable;

/** Minimal event emitter, shaped like `vscode.EventEmitter` so services stay free of the VS Code API. */
export class Emitter<T> implements Disposable {
  private readonly listeners = new Set<(event: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
