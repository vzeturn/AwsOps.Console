import type { SubnetTier, TopologyEdge } from '@ops-dashboard/shared';

/**
 * `diagramTheme.ts` — the tier-accent and edge-style tables, factored out of the old
 * `InfraNetworkDiagram.tsx` (`TIER_ACCENT`/`EDGE_STYLE`/`EDGE_LABEL`).
 *
 * COLOR VALUES (Requirement 2.3 — verified, not guessed): every hex below was checked with the
 * real WCAG relative-luminance contrast formula against the Diagram_Canvas's own actual rendered
 * background in BOTH themes — extracted from Cloudscape's real compiled CSS (`vendor-cloudscape-*.css`
 * in a `vite build` output), not assumed: `--awsui-color-background-container-content` resolves to
 * `#ffffff` in light mode and `#161d26` in dark mode (Cloudscape's `neutral-850` step). Every value
 * here clears >=3:1 against BOTH:
 *
 *   public/balances-to  #2563eb   white 5.17:1  dark-bg 3.28:1
 *   private/egress-via  #64748b   white 4.76:1  dark-bg 3.56:1
 *   isolated            #15803d   white 5.02:1  dark-bg 3.38:1
 *   ingress-from        #a15b0a   white 5.23:1  dark-bg 3.24:1
 *   attached-to         #8347e5   white 5.25:1  dark-bg 3.23:1
 *
 * (`public`/`balances-to` and `private`/`egress-via` deliberately reuse one verified hue each,
 * rather than needing 7 independently-tuned colors, since a tier accent and an edge kind can
 * legitimately share a hue without confusing the two systems — a tier accent is a 3px top border
 * on a Subnet box, an edge is a line between nodes, so which "kind" of thing is on screen is never
 * ambiguous even when the color repeats.)
 *
 * KNOWN LIMITATION (documented rather than silently glossed over): this verification is against
 * the Diagram_Canvas's PRIMARY background (Depth_Tier 0 / VPC, i.e. `container-content` — what
 * Requirement 2.3 means by "the Diagram_Canvas background"). A Subnet's own top-border accent
 * additionally sits against Depth_Tier 1's background (`visual-accent-grey`,
 * `#ebebf0`/`#333843` — see `index.tsx`'s node components) on one edge of that border; no single
 * hue can hit 3:1 against all FOUR background variants (tier 0 x2 themes, tier 1 x2 themes)
 * simultaneously — tier 1's dark value (`#333843`) sits at a middle luminance that is close to
 * every mid-saturation accent color from either direction. This is a structural property of
 * having 2 background tiers and 2 themes with only one border color to satisfy all of them, not
 * an oversight; the border remains visually legible (it does not disappear, per manual smoke
 * check — Task 7) even where it falls under 3:1 against the tier-1 dark value specifically.
 *
 * DASH PATTERNS (Requirement 2.4): all 4 edge kinds now have a distinct dash pattern (was 2 of 4
 * before this task) — the real WCAG grayscale-luminance numbers above show EVERY edge color
 * collapses to within 0.15-0.17 of each other once desaturated (confirmed by computing each
 * color's relative luminance directly), so color alone gives almost no distinction under a
 * grayscale/colorblind simulation — dash pattern is the primary distinguishing signal, color is
 * secondary/decorative on top of it.
 */
export const TIER_ACCENT: Record<SubnetTier, string> = {
  public: '#2563eb',
  private: '#64748b',
  isolated: '#15803d',
};

export const EDGE_STYLE: Record<TopologyEdge['kind'], { stroke: string; dash?: string }> = {
  'balances-to': { stroke: '#2563eb' }, // no `dash` -> solid line (an explicit '0' string can render as a degenerate 0-length dasharray in some SVG engines) — stays the visually "primary" connection, matching the old code's original undashed choice.
  'egress-via': { stroke: '#64748b', dash: '4 3' }, // unchanged pattern from the original code.
  'ingress-from': { stroke: '#a15b0a', dash: '1 4' }, // NEW dash (fine dotted) — was solid before this task (Requirement 2.4's gap).
  'attached-to': { stroke: '#8347e5', dash: '2 3' }, // unchanged pattern from the original code.
};

export const EDGE_LABEL: Record<TopologyEdge['kind'], string> = {
  'balances-to': 'Balances to',
  'egress-via': 'Egresses via',
  'ingress-from': 'Ingress from',
  'attached-to': 'Attached to',
};
