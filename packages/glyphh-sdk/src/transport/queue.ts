/**
 * queue.ts — a minimal async queue bridging the push-based transport (events arrive
 * when the wire delivers them) to the pull-based consumer (`for await`). Supports
 * graceful end and failure propagation.
 */

export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private ended = false;
  private failure: { error: unknown } | null = null;

  push(item: T): void {
    if (this.ended) return;
    const w = this.waiting.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiting) w.resolve({ value: undefined as never, done: true });
    this.waiting = [];
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = { error };
    this.ended = true;
    for (const w of this.waiting) w.reject(error);
    this.waiting = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
      },
    };
  }
}
