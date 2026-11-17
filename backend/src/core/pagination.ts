/**
 * Generic pagination helper — replaces the hand-written `do { ...; nextToken = NextToken; } while
 * (nextToken)` loop already duplicated across most collectors (`ec2-collector.ts`,
 * `topology-collector.ts`, `backup-collector.ts`, `serverless-collector.ts`,
 * `compute-optimizer-collector.ts`, ...) with one tested implementation.
 *
 * A rejection preserves the partial results gathered so far, and a page-count ceiling guards
 * against a token that never terminates.
 */

/**
 * Thrown when the page-fetching function passed to `fetchAllPages` rejects on any page after the
 * first. Carries every item successfully accumulated from prior pages so a caller that wants to
 * use partial data on failure can still access it — though every current call site in this
 * codebase's collectors treats this the same as any other error (log and return empty), matching
 * their pre-existing first-page-error behavior (Requirement 2.5 of `backend-core-foundation`).
 */
export class PaginatedFetchError<TItem> extends Error {
  public readonly partialResults: TItem[];
  public readonly cause: unknown;

  constructor(partialResults: TItem[], cause: unknown) {
    super('Paginated fetch failed after 1 or more successful pages');
    this.name = 'PaginatedFetchError';
    this.partialResults = partialResults;
    this.cause = cause;
  }
}

/**
 * Thrown when `fetchAllPages` reaches its configured `maxPages` limit without the underlying call
 * signaling "no more pages" — a safety valve against an unexpectedly large or misbehaving data
 * source looping indefinitely. Carries every item accumulated up to that point.
 */
export class PaginationLimitExceededError<TItem> extends Error {
  public readonly partialResults: TItem[];

  constructor(partialResults: TItem[], maxPages: number) {
    super(`Paginated fetch exceeded the configured page limit (${maxPages}) without a final page`);
    this.name = 'PaginationLimitExceededError';
    this.partialResults = partialResults;
  }
}

export interface PaginatedFetchOptions {
  /** Maximum number of pages to fetch before giving up with `PaginationLimitExceededError`.
   * Default 200 — generous enough for any real AWS Describe/List call in this codebase's
   * collectors, while still catching a genuinely broken page-fetching function during
   * development/testing rather than looping forever. */
  maxPages?: number;
}

interface Page<TItem, TToken> {
  items: TItem[];
  /** `undefined`, `null`, or `''` all mean "no further pages" — matches the range of "nothing
   * more to fetch" values AWS SDK v3 clients actually return across the different pagination
   * token field names used in this codebase (`NextToken`, `Marker`, `nextToken`). */
  nextToken: TToken | undefined | null;
}

/**
 * Repeatedly calls `fetchPage(token)`, starting with `token = undefined`, accumulating each page's
 * `items` into a single flattened array, until a page's `nextToken` is `undefined`/`null`/`''`.
 *
 * Does NOT retry a failed page itself — a page-fetching function that wants retry behavior (e.g.
 * for a throttled AWS API) should implement that inside itself, or rely on the AWS SDK client's
 * own configured retry strategy (see `core/aws-clients.ts`). This helper's only job is pagination,
 * not resilience.
 */
export async function fetchAllPages<TItem, TToken = string>(
  fetchPage: (token: TToken | undefined) => Promise<Page<TItem, TToken>>,
  options: PaginatedFetchOptions = {},
): Promise<TItem[]> {
  const maxPages = options.maxPages ?? 200;
  const result: TItem[] = [];
  let token: TToken | undefined;
  let pageCount = 0;

  do {
    let page: Page<TItem, TToken>;
    try {
      page = await fetchPage(token);
    } catch (cause) {
      throw new PaginatedFetchError(result, cause);
    }

    result.push(...page.items);
    pageCount += 1;

    const rawNextToken = page.nextToken;
    token = rawNextToken === null || rawNextToken === undefined || (rawNextToken as unknown) === '' ? undefined : rawNextToken;

    if (token !== undefined && pageCount >= maxPages) {
      throw new PaginationLimitExceededError(result, maxPages);
    }
  } while (token !== undefined);

  return result;
}
