import { describe, it, expect } from 'vitest';
import { fetchAllPages, PaginatedFetchError, PaginationLimitExceededError } from './pagination.js';

describe('fetchAllPages', () => {
  it('returns every item from a single page when no continuation token is returned', async () => {
    const result = await fetchAllPages(async () => ({ items: [1, 2, 3], nextToken: undefined }));
    expect(result).toEqual([1, 2, 3]);
  });

  it('merges items across 3 pages in order', async () => {
    let call = 0;
    const result = await fetchAllPages(async (token) => {
      call += 1;
      if (call === 1) {
        expect(token).toBeUndefined();
        return { items: ['a', 'b'], nextToken: 'page-2' };
      }
      if (call === 2) {
        expect(token).toBe('page-2');
        return { items: ['c'], nextToken: 'page-3' };
      }
      expect(token).toBe('page-3');
      return { items: ['d', 'e'], nextToken: undefined };
    });
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(call).toBe(3);
  });

  it.each([undefined, null, ''])('treats %p as "no further pages"', async (terminator) => {
    const result = await fetchAllPages(async () => ({ items: [42], nextToken: terminator }));
    expect(result).toEqual([42]);
  });

  it('rejects with PaginatedFetchError preserving prior pages when a later page fails', async () => {
    let call = 0;
    const boom = new Error('boom');
    const promise = fetchAllPages(async () => {
      call += 1;
      if (call === 1) return { items: [1, 2], nextToken: 'page-2' };
      throw boom;
    });

    await expect(promise).rejects.toBeInstanceOf(PaginatedFetchError);
    try {
      await promise;
    } catch (err) {
      const typed = err as PaginatedFetchError<number>;
      expect(typed.partialResults).toEqual([1, 2]);
      expect(typed.cause).toBe(boom);
    }
  });

  it('rejects with PaginationLimitExceededError once the configured maxPages is reached', async () => {
    let call = 0;
    const promise = fetchAllPages(
      async () => {
        call += 1;
        return { items: [call], nextToken: `token-${call}` };
      },
      { maxPages: 3 },
    );

    await expect(promise).rejects.toBeInstanceOf(PaginationLimitExceededError);
    try {
      await promise;
    } catch (err) {
      const typed = err as PaginationLimitExceededError<number>;
      expect(typed.partialResults).toEqual([1, 2, 3]);
    }
    expect(call).toBe(3);
  });

  it('does not throw the page limit error when the final page arrives exactly at maxPages', async () => {
    let call = 0;
    const result = await fetchAllPages(
      async () => {
        call += 1;
        return { items: [call], nextToken: call < 3 ? `token-${call}` : undefined };
      },
      { maxPages: 3 },
    );
    expect(result).toEqual([1, 2, 3]);
  });
});
