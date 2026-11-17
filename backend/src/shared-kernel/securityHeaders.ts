/**
 * Browser-protection response headers — applied to EVERY response from `router` (this file) and
 * `static-server` (`infra/static-server/index.ts`, which imports this module directly; esbuild
 * bundles it in, no separate deploy step needed).
 *
 * Rationale for each header (OWASP ASVS v5.0.0 §14.4 "HTTP Security Headers Requirements", OWASP
 * Top 10 2021 A05 "Security Misconfiguration" — see design.md D02-C07):
 *
 * - `content-security-policy`: the single strongest mitigation against XSS/data-injection — a
 *   restrictive allowlist of the ONLY origins this app legitimately talks to, instead of trusting
 *   every `<script>`/`fetch()` in the page. See `buildCsp()` below for exactly what's allowed and why.
 * - `strict-transport-security`: forces the browser to only ever connect over HTTPS to this origin
 *   for the next year, incl. subdomains — Lambda Function URLs are HTTPS-only already, this header
 *   defends against protocol-downgrade attacks (a MITM stripping HTTPS on a future HTTP redirect).
 * - `x-content-type-options: nosniff`: stops the browser from ignoring the `content-type` this app
 *   already sets carefully (see `contentTypeFor()` in static-server) and guessing a different one —
 *   the classic vector is a JSON/text response being reinterpreted and executed as HTML/JS.
 * - `referrer-policy: strict-origin-when-cross-origin`: never leaks the full URL (which can contain
 *   a JWT in a query string on some browsers' history, or a resource id) to a third-party origin in
 *   the `Referer` header — only the origin is sent cross-origin, the full URL only same-origin.
 * - `x-frame-options: DENY` + `frame-ancestors 'none'` (belt-and-suspenders, the CSP directive is
 *   the modern replacement but `X-Frame-Options` still covers older browsers that ignore CSP):
 *   this dashboard controls production AWS resources — being framed by another site (clickjacking)
 *   could trick an authenticated operator into confirming a destructive action they didn't intend.
 * - `permissions-policy`: explicitly turns off browser features this dashboard never uses
 *   (camera/microphone/geolocation) — defense in depth, costs nothing since none of them are used.
 *
 * NOT included: `x-xss-protection` — deprecated, removed from modern browsers, and can itself
 * introduce vulnerabilities in older ones (MDN explicitly recommends omitting it in favor of CSP).
 */

export interface SecurityHeadersOptions {
  /**
   * Extra origins allowed in `connect-src` beyond `'self'` and the Entra ID token endpoint —
   * needed because `router`'s API origin and `static-server`'s origin are two DIFFERENT Function
   * URLs (see README.md architecture section), so the page (served by static-server) must be
   * allowed to `fetch()` the router's origin. Pass the exact origin(s) the frontend calls,
   * e.g. `['https://<routerid>.lambda-url.<region>.on.aws']`.
   */
  connectSrcOrigins?: string[];
}

/**
 * Entra ID's token endpoint — the ONE external origin the frontend's `fetch()` calls during
 * sign-in/token-refresh (`oidc-client-ts` posts to `<authority>/oauth2/v2.0/token` directly, not
 * via an iframe — this app requests `offline_access` specifically so silent renewal never needs
 * the iframe-based flow that third-party-cookie blocking would break, see `oidcConfig.ts`).
 * Sign-in itself (`signinRedirect`) is a full top-level page navigation to
 * `login.microsoftonline.com/.../authorize`, not a framed/XHR request, so no `frame-src` grant is
 * needed for that step.
 */
const ENTRA_ORIGIN = 'https://login.microsoftonline.com';

function buildCsp(connectSrcOrigins: string[]): string {
  const connectSrc = ["'self'", ENTRA_ORIGIN, ...connectSrcOrigins].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    // 'unsafe-inline' on style-src only: recharts (SVG charting, used on Monitoring/Cost tabs)
    // sets inline `style` attributes on SVG elements it renders — there is no inline <script>
    // anywhere in this app (script-src stays strict with no 'unsafe-inline'/'unsafe-eval').
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * Returns the full set of browser-protection headers to merge into EVERY response (success,
 * error, and the OPTIONS preflight — misconfiguration/XSS defenses apply regardless of status
 * code). Callers merge this into their existing header object; this function never overwrites
 * `content-type`/CORS headers, it only adds the security-specific ones.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  return {
    'content-security-policy': buildCsp(options.connectSrcOrigins ?? []),
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}
