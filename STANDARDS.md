# STANDARDS.md — ops-dashboard engineering standards

> Engineering standards for this project. Source files cite sections of this document by number.

## §1. Evidence before claiming done

A change is not "done" because the code was written — it is done once the actual command was run and
its real output was read. Concretely:

- Never report a test suite as passing without having run it and read the pass/fail counts from real
  output. "Should pass" is not a status.
- Never claim a UI change works without rendering/exercising it (a component test, or the actual dev
  server) — a green `tsc`/build is necessary, not sufficient, for a UI-facing change. Layout breakage,
  text overflow, and truncated strings do not show up in a type error.
- When reporting a verification step, paste the real summary line (e.g. "762 backend + 294 frontend
  tests passed"), not a paraphrase of what was expected to happen.

## §2. Two-tier design tokens (DTCG)

Colour and other design values live in exactly two tiers, never fewer:

1. **Primitive tier** (`tailwind.config.js` — `brand`, `accent`, `status`, `chart`) — raw colour
   values, defined once. Primitives are also the only place chart series colours (`chart-1..6`) live,
   since a multi-series chart legitimately needs more distinct hues than the semantic tier's small,
   deliberately-limited vocabulary provides.
2. **Semantic tier** (`surface-*`, `line-*`, `ink-*`, `primary`, `success`/`warning`/`danger` — defined
   in `frontend/tailwind.config.js` pointing at CSS custom properties declared in `frontend/src/index.css`)
   — named by ROLE (surface/text/border/status), not by hue. A component styles itself by role
   (`bg-surface-card`, `text-ink-muted`) and the token's underlying value swaps automatically between
   light/dark via the CSS variable, with no `dark:` variant repeated at every call site.

**Components reference the semantic tier only.** New or refactored components must not call
`brand-500`/`status-ok-600`/`slate-400` etc. directly — go through the semantic name instead. The one
correct exception is an **effect with no token equivalent** (e.g. a glass-blur/opacity literal in a
`variant` prop) — those stay as literals because forcing them into the token system would invent a
token nobody else needs.

## §3. No redundant round-trips

If a value is already available from a call already being made, do not make a second call just to
fetch it again. The concrete pattern: `DescribeInstances` is already needed to read `State`; the
instance's `Name` tag is in the SAME response, so read it from there rather than issuing a second
`DescribeTags`/`DescribeInstances` call. This applies generally — before adding an AWS API call, check
whether the data is already in hand from a call the same function is making anyway.

## §4b. A report-only security gate is not a gate

Numbered "4b" rather than "4" because every citation of this section in the codebase (`RUNBOOK.md`,
`.npmrc`, `infra/deploy.sh`) specifically says "§4b" — there may be a §4/§4a in whatever this document
originally was, but nothing in the codebase cites it, so nothing is reconstructed here for it. Do not
invent a §4a to fill the gap; add one later, with its own number, only once something actually needs
to cite it.

`npm audit --audit-level=high` (and `npm run test --workspaces`) run as MANDATORY steps in
`infra/deploy.sh`, and a failure of either stops the deploy immediately with **no environment-variable
bypass**. A security or test check that can be silenced by an env var, a `|| true`, or a "just this
once" flag is not a check — it is a suggestion, and a suggestion does not prevent deploying a known
vulnerability or broken code. If a gate is flaky (see `infra/deploy.sh`'s `audit_gate` retry wrapper
for the documented case of the npm advisory endpoint being unreliable on this network), fix the
flakiness — e.g. with a bounded retry that still fails closed — rather than removing the gate.

Separately, and unrelated to numbering: every collector that calls several independent data sources
(see `infra-collector.ts`'s `Promise.allSettled`, cited by name in `RUNBOOK.md` and this project's own
ESLint config) writes each source's result independently, so one source failing leaves the other
fresh instead of corrupting or blanking both. This is an established pattern in the code, not a
numbered STANDARDS.md rule — no citation ties it to this document specifically.

## Refactor in small parts; keep the build green between parts

A large mechanical change (a token migration, a translation pass, a rename across many files) is done
in small, independently-buildable, independently-testable slices — never as one uncommitted mega-diff.
Between every slice, the build must still pass and the app must still run. If a slice is large enough
that finishing it in one pass would mean going a long stretch without a green build, defer the rest to
a tracked backlog item instead of shipping it half-verified. Corollary: "the build is green" is not the
same claim as "the feature was visually/functionally verified" — see §1.
