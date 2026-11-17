/**
 * RFC 9457 ("Problem Details for HTTP APIs") `type`/`title` pairs for every status code this API
 * returns (see `lib/errors.ts` for the 6 `HttpError` factories, plus the generic 500 fallback in
 * `lib/response.ts::fail`). Each `type` is a STABLE URI a client can switch on programmatically
 * instead of pattern-matching the free-text `detail` string (design.md D12-C06) — none of them
 * resolve to a real published spec page; per RFC 9457 §3.1 a `type` member only needs to be a URI
 * that identifies the problem type, dereferencing it is optional ("when dereferenced, SHOULD
 * provide human-readable documentation" — not a hard requirement for an internal API with no
 * public API consumers yet).
 */

interface ProblemType {
  type: string;
  title: string;
}

const PROBLEM_TYPES: Record<number, ProblemType> = {
  400: { type: 'https://ops-dashboard.internal/problems/bad-request', title: 'Bad Request' },
  401: { type: 'https://ops-dashboard.internal/problems/unauthorized', title: 'Unauthorized' },
  403: { type: 'https://ops-dashboard.internal/problems/forbidden', title: 'Forbidden' },
  404: { type: 'https://ops-dashboard.internal/problems/not-found', title: 'Not Found' },
  429: { type: 'https://ops-dashboard.internal/problems/too-many-requests', title: 'Too Many Requests' },
  502: { type: 'https://ops-dashboard.internal/problems/bad-gateway', title: 'Bad Gateway' },
};

const INTERNAL_ERROR: ProblemType = {
  type: 'https://ops-dashboard.internal/problems/internal-error',
  title: 'Internal Server Error',
};

export function problemTypeFor(statusCode: number): ProblemType {
  return PROBLEM_TYPES[statusCode] ?? INTERNAL_ERROR;
}
