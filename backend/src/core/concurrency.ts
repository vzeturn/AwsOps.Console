/**
 * Generic bounded-concurrency helper — replaces a sequential `for` loop with `await` in its body
 * (previously used by `ec2-collector.ts`/`rds-collector.ts`'s `loadInstanceMetrics` to iterate
 * `GetMetricData` batches one at a time) with a worker-pool that runs up to N calls concurrently.
 *
 * A worker-pool over a shared index counter is used instead of chunk-then-`Promise.all`, so a
 * slow call does not hold back the rest of its chunk.
 */

export interface ConcurrencyFailure<TItem> {
  item: TItem;
  error: unknown;
}

/** Thrown by `mapWithConcurrency` when at least one mapped call rejects. Every OTHER item still
 * runs to completion before this is thrown (Requirement 4.3 of `backend-core-foundation`) — this
 * error's `failures` array names exactly which input item(s) failed and why. */
export class MapWithConcurrencyError<TItem> extends Error {
  public readonly failures: ConcurrencyFailure<TItem>[];

  constructor(failures: ConcurrencyFailure<TItem>[], totalItems: number) {
    super(`${failures.length}/${totalItems} item(s) failed`);
    this.name = 'MapWithConcurrencyError';
    this.failures = failures;
  }
}

/**
 * Maps `items` through `fn`, running at most `concurrency` calls at a time, preserving input
 * order in the returned array regardless of the order individual calls actually settle in.
 *
 * If any call rejects, every other already-in-flight/pending call is still allowed to run to
 * completion — the returned Promise rejects only once every item has been attempted, with a
 * `MapWithConcurrencyError` naming every failed item.
 */
export async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  fn: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  const failures: ConcurrencyFailure<TItem>[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failures.push({ item: items[index], error });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    throw new MapWithConcurrencyError(failures, items.length);
  }
  return results;
}
