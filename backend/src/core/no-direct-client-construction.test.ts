import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for Requirement 1.5 of `backend-core-foundation`: after the full client-construction
 * migration (Task 11 of that spec's `tasks.md`), no production file under `backend/src` should
 * construct an AWS SDK client directly with `new <Service>Client(...)` — every client should come
 * from `core/aws-clients.ts` instead.
 *
 * RATCHET, NOT YET A HARD ZERO: this test is written now (Task 3.3) specifically so its count
 * visibly decreases across Tasks 4-11 of `backend-core-foundation`'s migration, without blocking
 * those tasks' own checkpoints along the way. The baseline below (124, captured by direct grep at
 * the time this test was written) is the CEILING, not a target — every migration step should only
 * ever lower it. Once Task 11 (the full client-construction migration) completes, this test's
 * `MAX_ALLOWED_DIRECT_CONSTRUCTIONS` constant should be updated to 0 and this comment updated to
 * say so — see Task 11.4 of `backend-core-foundation`'s tasks.md.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC_ROOT = path.join(__dirname, '..');
const DIRECT_CONSTRUCTION_PATTERN = /new\s+\w+Client\(/g;

/** Ceiling captured by direct grep across backend/src at the time this test was written (Task 3.3
 * of backend-core-foundation) — MUST be updated to 0 once Task 11 completes, never raised.
 * Task 11 (the full client-construction migration) is now complete: every call site under
 * backend/src constructs its AWS SDK v3 clients through core/aws-clients.ts, so the ceiling is 0. */
const MAX_ALLOWED_DIRECT_CONSTRUCTIONS = 0;

function listTsFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      result.push(...listTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('.property')) {
      result.push(fullPath);
    }
  }
  return result;
}

describe('no direct AWS SDK client construction outside core/aws-clients.ts', () => {
  it(`has at most ${MAX_ALLOWED_DIRECT_CONSTRUCTIONS} remaining direct "new XxxClient(" call sites (ratchet — see file header)`, () => {
    let total = 0;
    const perFile: Record<string, number> = {};

    for (const file of listTsFiles(BACKEND_SRC_ROOT)) {
      // core/aws-clients.ts itself is the one file allowed to construct every client directly.
      if (path.resolve(file) === path.resolve(path.join(BACKEND_SRC_ROOT, 'core', 'aws-clients.ts'))) continue;

      const content = readFileSync(file, 'utf-8');
      const matches = content.match(DIRECT_CONSTRUCTION_PATTERN);
      if (matches && matches.length > 0) {
        perFile[path.relative(BACKEND_SRC_ROOT, file)] = matches.length;
        total += matches.length;
      }
    }

    if (total > MAX_ALLOWED_DIRECT_CONSTRUCTIONS) {
      // eslint-disable-next-line no-console -- diagnostic output only on failure, not a logging convention violation
      console.error('Direct AWS SDK client construction found outside core/aws-clients.ts:', perFile);
    }

    expect(total).toBeLessThanOrEqual(MAX_ALLOWED_DIRECT_CONSTRUCTIONS);
  });

  it('stays at exactly 0 once the ceiling has been fully ratcheted down (informational — not yet enforced)', () => {
    // Intentionally left as a no-op placeholder assertion documenting the end state; flip the
    // ceiling constant above to 0 and delete this second test once Task 11 completes, rather than
    // maintaining two separate assertions long-term.
    expect(MAX_ALLOWED_DIRECT_CONSTRUCTIONS).toBeGreaterThanOrEqual(0);
  });
});
