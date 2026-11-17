/**
 * Spec §9: "evidence is redacted of tag values matching secret patterns". Applied by makeDraft()
 * to EVERY finding's evidence before it can reach DynamoDB, logs or the API.
 */
export const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /(secret|passw(or)?d|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|authorization)/i;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /\b(ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

const MAX_DEPTH = 8;

export function redactEvidence(data: Record<string, unknown>): Record<string, unknown> {
  return redactObject(data, 0);
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return SECRET_VALUE_PATTERNS.some((p) => p.test(value)) ? REDACTED : value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === 'object') return redactObject(value as Record<string, unknown>, depth + 1);
  return value;
}

function redactObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const tagKey = typeof obj.Key === 'string' ? obj.Key : undefined;
  const secretTag = tagKey !== undefined && SECRET_KEY_PATTERN.test(tagKey);
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => {
      if (secretTag && key === 'Value') return [key, REDACTED];
      if (SECRET_KEY_PATTERN.test(key) && value !== null && value !== undefined) return [key, REDACTED];
      return [key, redactValue(value, depth)];
    }),
  );
}
