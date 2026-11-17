import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Controls, Background, type Node, type Edge } from '@xyflow/react';
import Box from '@cloudscape-design/components/box';
import Spinner from '@cloudscape-design/components/spinner';
import type { ThresholdMeta, TopologyEdge, TopologyResource, TopologyVpc } from '@ops-dashboard/shared';
import { computeVpcLayout } from './elkLayoutAdapter';
import { ResourceNode, type ResourceNodeData } from './nodes/ResourceNode';
import { VpcGroupNode } from './nodes/VpcGroupNode';
import { SubnetGroupNode } from './nodes/SubnetGroupNode';
import { InternetNode } from './nodes/InternetNode';
import { TopologyEdgeComponent } from './TopologyEdgeComponent';

/**
 * `nodeTypes`/`edgeTypes` MUST be defined OUTSIDE the component (module scope), not inline inside
 * it — React Flow's own performance documentation: passing a fresh object literal on every render
 * makes React Flow think the node/edge type registry itself changed, forcing every single node to
 * fully remount instead of just re-rendering. Module-scope keeps the same object reference across
 * every render for the lifetime of the app.
 */
const nodeTypes = {
  vpcGroup: VpcGroupNode,
  subnetGroup: SubnetGroupNode,
  resource: ResourceNode,
  internet: InternetNode,
};

const edgeTypes = {
  topologyEdge: TopologyEdgeComponent,
};

export interface VpcDiagramCanvasProps {
  vpc: TopologyVpc;
  resourcesBySubnet: Map<string, TopologyResource[]>;
  health: Map<string, ThresholdMeta>;
  onResourceClick: (resource: TopologyResource) => void;
  edges: TopologyEdge[];
}

/**
 * `VpcDiagramCanvas` — one VPC's full React Flow diagram. Replaces the old hand-built
 * `DiagramCanvas` (manual `getBoundingClientRect()` measurement + a raw SVG overlay for edges,
 * see the deleted `InfraNetworkDiagram.tsx`'s own `useNodeRects`/`DiagramCanvas`) with
 * `computeVpcLayout` (ELK) feeding straight into `<ReactFlow>`'s own `nodes`/`edges` props — no DOM
 * measurement step is needed at all, since ELK computes every position before anything is ever
 * painted (design.md's Data Flow section).
 *
 * `computeVpcLayout` is async (`elk.layout()` itself is Promise-based, whether or not it actually
 * runs on a Worker) — this component owns the one bit of async state that entails: a `nodes`/
 * `edges` pair in local state, recomputed whenever the VPC/resources/edges this canvas is showing
 * change. `health`/`onResourceClick` are injected into each resource node's `data` AFTER layout
 * (not passed into `computeVpcLayout` at all) because they can change far more often than the
 * topology's shape does (e.g. `health` refreshes on every metrics poll) — recomputing the entire
 * ELK layout on every health tick would be wasteful and would visually jitter node positions for
 * no structural reason; only the resource nodes' `data` needs to reflect the latest `health`/
 * callback, not their positions.
 */
export function VpcDiagramCanvas({ vpc, resourcesBySubnet, health, onResourceClick, edges }: VpcDiagramCanvasProps) {
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    computeVpcLayout({ vpc, resourcesBySubnet, edges }).then((result) => {
      if (!cancelled) setLayout(result);
    });
    return () => {
      cancelled = true;
    };
    // `resourcesBySubnet`/`edges` are recreated by the parent on every `data` change (new
    // `useMemo`/prop identity) — including them keeps this effect's dependency list honest rather
    // than relying on `vpc` alone and risking a stale layout if resources change without the VPC
    // object itself changing.
  }, [vpc, resourcesBySubnet, edges]);

  const renderedNodes = useMemo(() => {
    if (!layout) return [];
    return layout.nodes.map((node): Node => {
      if (node.type !== 'resource') return node;
      const resource = (node.data as { resource: TopologyResource }).resource;
      const data: ResourceNodeData = { resource, threshold: health.get(resource.id), onResourceClick };
      return { ...node, data };
    });
  }, [layout, health, onResourceClick]);

  if (!layout) {
    return (
      <Box textAlign="center" padding="l">
        <Spinner size="normal" /> <Box variant="span">Computing layout…</Box>
      </Box>
    );
  }

  return (
    <div style={{ height: 520, border: '1px solid var(--awsui-color-border-divider-default, #e9ebed)', borderRadius: 8 }}>
      <ReactFlow
        nodes={renderedNodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
      >
        {/* `proOptions.hideAttribution` is intentionally NOT set here — React Flow's own terms
            reserve removing the "React Flow" attribution mark for Pro subscribers; this project
            has no such subscription, so the default attribution stays visible (bottom-right,
            React Flow's own default styling) rather than risk a license/ToS violation. */}
        <Controls showInteractive={false} />
        <Background />
      </ReactFlow>
    </div>
  );
}
