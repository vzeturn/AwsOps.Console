import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

/**
 * One flat config for the whole monorepo (shared/backend/frontend), run from the root via
 * `npm run lint --workspaces --if-present` delegating to this file — see the `lint` script in each
 * workspace's `package.json`.
 *
 * WHY ONE FILE INSTEAD OF THREE. The three workspaces already share `strict: true` TypeScript and a
 * single root `npm test`/`npm run build` pipeline; a separate `eslint.config.mjs` per workspace would
 * just be the same base rules copy-pasted three times with a slightly different `files` glob. One
 * config with per-directory overrides keeps the ruleset itself in one place to change.
 *
 * DELIBERATELY NOT TYPE-CHECKED (`recommended`, not `recommendedTypeChecked`). Type-aware linting
 * needs a full TS program per file and is measurably slower on a codebase this size (127 backend +
 * 61 frontend test files) — `tsc --noEmit` in each workspace's own `typecheck` script already catches
   every type error with the compiler itself, which is strictly more accurate for that job than ESLint's
 * type-aware rules layered on top of it. Keeping lint fast and type-checking separate is what makes
 * `npm run lint` something to actually run locally rather than a slow gate people route around.
 */
export default tseslint.config(
  {
    // Build output, coverage, and vendored/AI-worktree copies of this same repo — linting a build
    // artifact or a nested checkout would just double-report the same issue under a different path.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.claude/**',
      'infra/build/**',
      'infra/out.yaml',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------------------------
  // Backend + shared: plain Node/TypeScript, no JSX.
  // ---------------------------------------------------------------------------------------------
  {
    files: ['backend/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // A handler that ignores a Promise (fire-and-forget against an AWS SDK call) fails silently —
      // the exact failure mode this codebase's own collectors go out of their way to avoid (see the
      // `Promise.allSettled` pattern cited in RUNBOOK.md §3). `ignoreVoid` lets an explicit `void
      // somePromise()` still opt out for the rare genuine fire-and-forget case, same as upstream's own
      // recommended usage.
      '@typescript-eslint/no-floating-promises': 'off', // requires type info; see note above on why this config stays non-type-checked
      // `ignoreRestSiblings`: this codebase's established pattern for "every param except these N" is
      // `const { a, b, ...rest } = obj` (see `actions-preview.ts`'s `_recommendationId`/`_actionType`/
      // `_resourceId` exclusion, chosen specifically to avoid hardcoding an allowlist of action
      // parameters). That is a deliberate use of the destructured binding, not dead code — flagging it
      // would make the codebase's own established idiom fail lint.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // AWS SDK responses are typed as `any` in a few older client shapes; `no-explicit-any` would be
      // noise there rather than signal. Downgraded to a warning instead of silenced entirely, so a
      // genuinely avoidable `any` in new code still shows up without failing the whole lint run over
      // an SDK type gap nobody here controls.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `logger.ts` is the ONE place allowed to call `console.*` directly (see its own doc comment) —
      // every other handler/collector/service goes through `logger.info/warn/error` so every log line
      // is the same structured JSON shape CloudWatch Logs Insights can query by field. This used to be
      // an unenforced comment; now it is a real lint rule instead of a convention someone has to
      // remember.
      'no-console': 'error',
    },
  },
  {
    files: ['backend/src/shared-kernel/logger.ts'],
    rules: { 'no-console': 'off' },
  },

  // ---------------------------------------------------------------------------------------------
  // Frontend build-time scripts (config generation, run under Node during `vite build`/deploy, never
  // shipped to the browser) — Node globals, not browser globals.
  // ---------------------------------------------------------------------------------------------
  {
    files: ['frontend/scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // `new Function(...)` is a code-injection surface everywhere except the one place this
      // codebase deliberately uses it: `generate-config.test.mjs` round-trips the generated
      // `config.js` through it to prove the emitted JS actually parses and assigns the value it
      // claims to — a test-only, non-dynamic use of a literal template string, not user input.
      'no-new-func': 'error',
    },
  },
  {
    files: ['frontend/scripts/generate-config.test.mjs'],
    rules: { 'no-new-func': 'off' },
  },

  // ---------------------------------------------------------------------------------------------
  // Frontend public/ static assets served as-is (never bundled) — `config.js` (see its own doc
  // comment) sets `window.__APP_CONFIG__` directly, so it needs browser globals, not Node's.
  // ---------------------------------------------------------------------------------------------
  {
    files: ['frontend/public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Frontend: React + JSX + browser globals + accessibility linting.
  // ---------------------------------------------------------------------------------------------
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      ...jsxA11y.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // The React Hooks rule set already caught the exact class of bug documented at the top of
      // `InfraMapTab.tsx` (a hook declared after an early `return`, which crashed the tab in
      // production — React error #310). `rules-of-hooks` stays at its recommended `error`; nothing
      // here downgrades it.
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Test files everywhere: looser about `any` (mocks/fixtures legitimately need it more often) and
  // about unused vars in destructured mock args.
  // ---------------------------------------------------------------------------------------------
  {
    files: ['**/*.test.{ts,tsx}', '**/*.property*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
