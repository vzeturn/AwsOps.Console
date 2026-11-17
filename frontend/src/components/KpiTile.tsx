import type { ReactNode } from 'react';
import Box from '@cloudscape-design/components/box';
import Icon from '@cloudscape-design/components/icon';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { IconProps } from '@cloudscape-design/components/icon';

/**
 * A single "stat card" — the building block behind the KPI rows added to every data-heavy page
 * (Cost/Assessment/Infra Map/Monitoring). Modeled on the metric-tile pattern Datadog/Grafana-style
 * dashboards use everywhere: one big number, a short label, and (optionally) a colored delta
 * showing direction of change — so a page communicates "what changed and is it good or bad" at a
 * glance, instead of making the reader compute that themselves from two separate numbers in a table.
 *
 * Deliberately built ONLY from Cloudscape primitives (`Box`/`Icon`/`SpaceBetween`, all already
 * theme/dark-mode/density aware via `@cloudscape-design/global-styles`) — no custom CSS, no new
 * color tokens. The "Datadog look" comes from composition (size contrast, the colored trend
 * pairing an icon with a `Box.color`), not from a new visual language competing with Cloudscape's.
 */
export interface KpiTileProps {
  label: string;
  /** Pre-formatted display value (caller formats currency/units) — kept as a string so this
   * component has zero formatting opinions of its own. */
  value: string;
  /** Optional secondary line under the value, e.g. "of $1,240 forecast" or "12 resources". */
  caption?: string;
  /**
   * Trend vs. a comparison period. `direction` picks the icon + color:
   * - 'up' + tone 'negative' (cost went up = bad) or tone 'positive' (throughput went up = good)
   * - 'down' + the inverse
   * - 'flat' shows no arrow, neutral color
   * Callers decide `tone` explicitly rather than this component guessing from the sign of a number
   * — "cost went up" and "healthy resource count went up" both have direction 'up' but OPPOSITE
   * meaning, and guessing that wrong would show a misleadingly reassuring green up-arrow on a cost
   * increase.
   */
  trend?: {
    direction: 'up' | 'down' | 'flat';
    tone: 'positive' | 'negative' | 'neutral';
    label: string;
  };
  /** Overall severity of the tile itself (independent of `trend`) — colors the big value, used for
   * things like "3 critical alarms" where the number itself needs to read as alarming regardless
   * of whether it went up or down since last time. */
  severity?: 'critical' | 'warning' | 'ok' | 'neutral';
  /**
   * (infra-map-redesign spec, Requirement 1) When provided, the tile becomes an Interactive_Kpi:
   * `cursor: pointer`, a visible focus ring, `role="button"`, `tabIndex=0`, and Enter/Space
   * activation, all calling this handler. Omitted (the default for every OTHER current caller —
   * `cost.tsx`, `assessment.tsx`, and every other route listed above) renders this component
   * EXACTLY as it did before this prop existed (Requirement 1.3/1.4) — a purely additive,
   * optional prop, not a behavior change for anyone who doesn't pass it.
   *
   * Only pass this when the tile represents a drillable subset of the page's OWN data that has a
   * real, single, existing on-page target to scroll to — inventing one for a tile with no actual
   * drill-down target (e.g. "VPCs", "Subnets" on `/infra-map` — several VPCs exist behind `Tabs`,
   * there is no one place "all VPCs" scrolls to) would visually promise an action that doesn't
   * exist, which is the exact problem Requirement 1 exists to fix, not something to reintroduce.
   */
  onActivate?: () => void;
  /**
   * Required (enforced by a runtime dev-mode warning below, not a TypeScript-level requirement —
   * a type-level `required-if` would force every caller to touch this prop even when adding
   * `onActivate` for the first time, which is more friction than the payoff justifies for a single
   * dev-time check) whenever `onActivate` is set. Screen-reader text describing the action, e.g.
   * "Scroll to unplaced resources" — read instead of the tile's own label/value, since "12,
   * Unplaced resources" on its own does not tell an assistive-technology user that activating it
   * does anything at all.
   */
  activateLabel?: string;
}

const SEVERITY_COLOR: Record<NonNullable<KpiTileProps['severity']>, 'text-status-error' | 'text-status-warning' | 'text-status-success' | 'inherit'> = {
  critical: 'text-status-error',
  warning: 'text-status-warning',
  ok: 'text-status-success',
  neutral: 'inherit',
};

const TREND_COLOR: Record<NonNullable<KpiTileProps['trend']>['tone'], 'text-status-error' | 'text-status-success' | 'text-body-secondary'> = {
  negative: 'text-status-error',
  positive: 'text-status-success',
  neutral: 'text-body-secondary',
};

const TREND_ICON: Record<NonNullable<KpiTileProps['trend']>['direction'], IconProps.Name | undefined> = {
  up: 'caret-up-filled',
  down: 'caret-down-filled',
  flat: undefined,
};

export function KpiTile({ label, value, caption, trend, severity = 'neutral', onActivate, activateLabel }: KpiTileProps) {
  if (onActivate && !activateLabel && import.meta.env.DEV) {
    // Dev-mode-only warning (Requirement 1.4's own design: a runtime check, not a type-level
    // requirement) — an Interactive_Kpi with no `activateLabel` would still visually work but
    // would announce nothing useful to a screen reader on focus, silently failing the same
    // "honest about what it can do" goal this whole prop exists to satisfy.
    // eslint-disable-next-line no-console -- intentional dev-mode diagnostic, matches this codebase's existing convention of console warnings for dev-only misuse (see elkjs's own graceful-degradation warning this spec's design.md cites).
    console.warn('KpiTile: `onActivate` was provided without `activateLabel` — add one so screen readers announce what activating this tile does.');
  }

  const content = (
    <SpaceBetween size="xxs">
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="awsui-value-large" color={SEVERITY_COLOR[severity]}>
        {value}
      </Box>
      {caption && (
        <Box fontSize="body-s" color="text-body-secondary">
          {caption}
        </Box>
      )}
      {trend && (
        <Box fontSize="body-s" color={TREND_COLOR[trend.tone]}>
          <SpaceBetween direction="horizontal" size="xxs" alignItems="center">
            {TREND_ICON[trend.direction] && <Icon name={TREND_ICON[trend.direction]} variant="normal" size="small" />}
            <span>{trend.label}</span>
          </SpaceBetween>
        </Box>
      )}
    </SpaceBetween>
  );

  // Requirement 1.4: omitting `onActivate` renders byte-for-byte what this component rendered
  // before this prop existed — no wrapping `div`, no `role`/`tabIndex`/`onClick`/`onKeyDown` at
  // all, not merely a no-op handler, so every existing caller's DOM output is unaffected.
  if (!onActivate) return content;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={activateLabel}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      style={{ cursor: 'pointer', outlineOffset: 2 }}
      className="infra-map-kpi-tile-interactive"
    >
      {content}
    </div>
  );
}

/** A row of `KpiTile`s laid out as equal-width columns inside one `Container` — the shape every
 * redesigned page uses for its top summary strip. Kept as a thin wrapper (not folded into
 * `KpiTile` itself) so a page can still lay out tiles differently if it ever needs to. */
export function KpiTileRow({ children }: { children: ReactNode }) {
  return (
    <Box padding={{ vertical: 'xs' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '20px',
        }}
      >
        {children}
      </div>
    </Box>
  );
}
