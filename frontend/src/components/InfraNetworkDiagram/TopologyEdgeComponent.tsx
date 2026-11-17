import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import type { TopologyEdge } from '@ops-dashboard/shared';
import { EDGE_STYLE } from './diagramTheme';

/**
 * `TopologyEdgeComponent` — the React Flow custom edge type `'topologyEdge'`. Replaces the old
 * hand-drawn SVG `<path>` overlay (`DiagramCanvas`'s own bezier-curve math against manually
 * measured `getBoundingClientRect()` rects) with React Flow's own `getSmoothStepPath` +
 * `<BaseEdge>` — React Flow already computes `sourceX`/`sourceY`/`targetX`/`targetY` from the
 * ELK-derived node positions, so no manual rect measurement is needed here at all (design.md's
 * Data Flow section: this is exactly the DOM-measurement mechanism `elkLayoutAdapter.ts` makes
 * unnecessary).
 *
 * `interactionWidth` (React Flow's own built-in wide invisible hit-area, default 20px) replaces
 * the old code's manually-drawn "wide invisible path drawn first" `<path stroke="transparent"
 * strokeWidth={12}>` trick — same purpose (easier hover/click without needing pixel-precise aim
 * on a thin line), now handled by the library instead of hand-rolled.
 */
export function TopologyEdgeComponent({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps & { data?: { kind: TopologyEdge['kind'] } }) {
  const kind = data?.kind ?? 'balances-to';
  const style = EDGE_STYLE[kind];
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  // React Flow's <BaseEdge> has no native per-edge tooltip slot the way a raw hand-drawn SVG
  // <path><title>...</title></path> did in the old code — the edge's meaning (what each
  // color/dash pattern represents) is instead conveyed by the always-visible `DiagramLegend`
  // (Requirement 6: moved to the TOP of the diagram specifically so it is read before, not
  // instead of, an on-hover tooltip this component does not have).
  return <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: style.stroke, strokeWidth: 1.5, strokeDasharray: style.dash }} />;
}
