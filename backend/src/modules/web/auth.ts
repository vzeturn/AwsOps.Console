import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { config } from '../../config.js';
import { forbidden, unauthorized } from '../../shared-kernel/errors.js';
import { logger } from '../../shared-kernel/logger.js';

const jwksUrl = new URL(`https://login.microsoftonline.com/${config.entraTenantId}/discovery/v2.0/keys`);
const issuer = `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`;
const audience = [config.entraClientId, `api://${config.entraClientId}`];

/**
 * Microsoft Entra ID JWKS — created exactly once at module scope. `createRemoteJWKSet`
 * caches keys by `kid` itself and refetches automatically on a new `kid` — it must NOT be
 * recreated on every verify (loses the cache + wastes a network round-trip per request).
 */
const remoteJwks = createRemoteJWKSet(jwksUrl);

function readHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function extractBearerToken(event: LambdaFunctionURLEvent): string {
  const authHeader = readHeaderCaseInsensitive(event.headers, 'authorization');
  if (!authHeader) throw unauthorized('Missing Authorization header');

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match?.[1]) throw unauthorized('Authorization header must be in the form "Bearer <token>"');
  return match[1];
}

/**
 * Checks whether the token's `groups` claim intersects `config.allowedGroupIds`.
 * Skipped if `allowedGroupIds` is empty (no group restriction).
 */
/**
 * `true` when the token uses `_claim_names` instead of `groups` — Entra ID does this when the
 * account belongs to TOO MANY groups to include directly in the claim ("group overage"). In this
 * case `payload.groups` does NOT exist, so every membership check would yield "belongs to no
 * group" — a FALSE NEGATIVE, not a real answer.
 */
export function hasGroupClaimOverage(payload: Record<string, unknown>): boolean {
  return typeof payload._claim_names === 'object' && payload._claim_names !== null;
}

function assertGroupMembership(payload: Record<string, unknown>): void {
  if (config.allowedGroupIds.length === 0) return;

  if (hasGroupClaimOverage(payload)) {
    throw forbidden(
      'Account belongs to too many groups (exceeds Entra ID direct claim limit) — unable to determine access.',
    );
  }

  const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
  const isAllowed = groups.some((groupId) => config.allowedGroupIds.includes(groupId));
  if (!isAllowed) {
    throw forbidden('Account is not a member of a group allowed to use this application');
  }
}

/**
 * Checks whether the token's `groups` claim intersects `config.operatorGroupIds` — a SEPARATE
 * gate for resource-lifecycle action permissions (EC2_Reboot/RDS_Start/RDS_Stop/RDS_Reboot on
 * InfraTab, see `handlers/actions-lifecycle.ts`), independent of `assertGroupMembership()` (the
 * general sign-in gate, `allowedGroupIds`). Does NOT throw — returns a `boolean` so `/me` can
 * expose `isOperator` to the UI, letting the handler calling this function decide when to throw
 * `forbidden(...)`.
 *
 * Empty = `false` (`operatorGroupIds` not configured = NO ONE has operator rights) — a safer
 * default, the OPPOSITE of `assertGroupMembership()` (empty = no group restriction).
 *
 * GROUP OVERAGE: also returns `false` (fail closed, the right direction) BUT with a `logger.warn`
 * — because this is "cannot be determined", NOT "is not an operator", and from the UI/support
 * ticket standpoint the two cases look identical. `/me` distinguishes them via
 * `operatorStatusUnknown` (see `me.ts`); it does NOT throw like `assertGroupMembership()`
 * because this function runs on the `/me` request path — throwing would break the entire
 * dashboard instead of just hiding the action button.
 */
export function isOperatorMember(payload: Record<string, unknown>): boolean {
  if (config.operatorGroupIds.length === 0) return false;
  if (hasGroupClaimOverage(payload)) {
    logger.warn(
      'Unable to determine operator rights: token uses _claim_names (account belongs to too many Entra ID groups), treating as NOT an operator',
      { sub: payload.sub, preferred_username: payload.preferred_username },
    );
    return false;
  }
  const groups = Array.isArray(payload.groups) ? payload.groups.map(String) : [];
  return groups.some((groupId) => config.operatorGroupIds.includes(groupId));
}

/**
 * Verify the Microsoft Entra ID JWT: RS256 signature via the real JWKS, issuer, audience,
 * expiry — performed by `jose`'s `jwtVerify`, not a hand-rolled signature verification.
 */
export async function verifyEntraToken(
  event: LambdaFunctionURLEvent,
  jwks: JWTVerifyGetKey = remoteJwks,
): Promise<Record<string, unknown>> {
  const token = extractBearerToken(event);

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer, audience }));
  } catch (err) {
    try {
      logger.error('Entra ID JWT verification failed', {
        err,
        expectedIssuer: issuer,
        expectedAudience: audience,
        tokenHeader: decodeProtectedHeader(token),
        tokenClaims: decodeJwt(token),
      });
    } catch {
      logger.error('Entra ID JWT verification failed (could not decode token)', err);
    }
    throw unauthorized('Invalid or expired token');
  }

  assertGroupMembership(payload);
  return payload;
}
