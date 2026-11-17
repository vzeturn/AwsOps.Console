export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function unauthorized(message: string): HttpError {
  return new HttpError(401, message);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message);
}

/** A state precondition failed (e.g. acknowledging a finding that is no longer `open`). */
export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

/** A CloudWatch Logs throttle (`ThrottlingException`/`LimitExceededException`) when the user
 * hammers "Search"/"Load more" in quick succession is a "retry later" signal, NOT a system
 * failure. Return 429 so the UI says exactly that instead of a 500 that makes the operator think
 * the dashboard is broken. */
export function tooManyRequests(message: string): HttpError {
  return new HttpError(429, message);
}

/** `lambda:InvokeFunction` itself failing at the invoke layer (throttle, permission, or the target
 * Lambda crashing uncaught) is NOT a valid business outcome — it must not return a fake
 * `outcome: 'success'` (see design.md, "Error Handling" section for `POST /actions/execute`). */
export function badGateway(message: string): HttpError {
  return new HttpError(502, message);
}
