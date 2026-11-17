import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { TopologyEdge } from '@ops-dashboard/shared';
import { EDGE_STYLE, EDGE_LABEL } from './diagramTheme';

/**
 * `DiagramLegend` — renders BEFORE the Diagram_Canvas (Requirement 6.1; wired by `index.tsx`,
 * which places this ahead of `VpcDiagramCanvas`/`Tabs`) so an operator reads what each edge
 * color/dash means before looking at a diagram that already uses them, not as an afterthought
 * scrolled past on the way down.
 *
 * Restyled (Requirement 6.2) from a bare `SpaceBetween` row with no visual boundary into a
 * compact, visually contained panel: a `Box` with padding and a bottom border
 * (`borderBlockEnd`, Cloudscape's own divider-token convention, matching the border style already
 * used elsewhere on this page e.g. `.infra-map-vpc-box`) — reads as a distinct strip separating
 * "how to read this" from the canvas below, rather than floating text with nothing containing it.
 */
export function DiagramLegend() {
  const kinds = Object.keys(EDGE_LABEL) as TopologyEdge['kind'][];
  return (
    <Box padding={{ vertical: 's', horizontal: 'm' }}>
      {/* `Box` has no built-in "divider on one edge only" prop, so the bottom border falls back to
          plain `style` here — same `--awsui-color-border-divider-default` custom property
          `.infra-map-vpc-box`/`.infra-map-subnet-box` already use, so this stays theme-safe. */}
      <div style={{ borderBottom: '1px solid var(--awsui-color-border-divider-default, #e9ebed)', paddingBottom: 8 }}>
        <SpaceBetween direction="horizontal" size="l">
          {kinds.map((kind) => (
            <SpaceBetween key={kind} direction="horizontal" size="xxs" alignItems="center">
              <svg width="24" height="8" aria-hidden>
                <line
                  x1="0"
                  y1="4"
                  x2="24"
                  y2="4"
                  stroke={EDGE_STYLE[kind].stroke}
                  strokeWidth={2}
                  strokeDasharray={EDGE_STYLE[kind].dash}
                />
              </svg>
              <Box fontSize="body-s" color="text-body-secondary">
                {EDGE_LABEL[kind]}
              </Box>
            </SpaceBetween>
          ))}
        </SpaceBetween>
      </div>
    </Box>
  );
}
