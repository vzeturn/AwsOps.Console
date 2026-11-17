import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, MapWithConcurrencyError } from './concurrency.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('returns results in input order even when later items resolve before earlier ones', async () => {
    const delays = [30, 10, 20];
    const result = await mapWithConcurrency(delays, 3, async (ms, index) => {
      await delay(ms);
      return index;
    });
    expect(result).toEqual([0, 1, 2]);
  });

  it('never runs more than `concurrency` calls at once', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight -= 1;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('runs every item to completion even when some reject, before rejecting itself', async () => {
    const items = [1, 2, 3, 4, 5];
    const attempted: number[] = [];

    const promise = mapWithConcurrency(items, 2, async (item) => {
      attempted.push(item);
      await delay(5);
      if (item % 2 === 0) throw new Error(`item ${item} failed`);
      return item * 10;
    });

    await expect(promise).rejects.toBeInstanceOf(MapWithConcurrencyError);
    expect(attempted.sort()).toEqual(items);

    try {
      await promise;
    } catch (err) {
      const typed = err as MapWithConcurrencyError<number>;
      expect(typed.failures.map((f) => f.item).sort()).toEqual([2, 4]);
    }
  });

  it('resolves an empty array for an empty input list without calling fn', async () => {
    let called = false;
    const result = await mapWithConcurrency([], 5, async () => {
      called = true;
      return 1;
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('behaves correctly when concurrency exceeds the number of items', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (item) => item * 2);
    expect(result).toEqual([2, 4]);
  });
});
