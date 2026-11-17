import type { NodeProps } from '@xyflow/react';
import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { TopologyVpc } from '@ops-dashboard/shared';

/**
 * `VpcGroupNode` — React Flow custom node type `'vpcGroup'`. Reuses the same header/badge/CIDR
 * label JSX the old hand-built `VpcBox` used; the SUBNETS themselves are no longer rendered
 * inside this component's own JSX — they are separate React Flow nodes with `parentId` set to
 * this VPC's id (`elkLayoutAdapter.ts`), which is how React Flow's own sub-flow containment works
 * (design.md's Architecture section). This component only renders the VPC's OWN header chrome;
 * React Flow positions/sizes the box itself from the Node's `style` (computed by ELK).
 *
 * Depth_Tier 0 background (Requirement 2.1/2.2) — kept as the existing `.infra-map-vpc-box` CSS
 * class (index.css), unchanged by this task; Task 5 revisits the elevation scale across all 3 tiers.
 */
export interface VpcGroupNodeData {
  vpc: TopologyVpc;
  // Satisfies React Flow's `Node<T>` generic constraint (`T extends Record<string, unknown>`) —
  // see the same note on `ResourceNodeData` in `ResourceNode.tsx`.
  [key: string]: unknown;
}

export function VpcGroupNode({ data }: NodeProps & { data: VpcGroupNodeData }) {
  const { vpc } = data;
  return (
    <div
      className="infra-map-vpc-box"
      style={{
        border: '2px solid var(--awsui-color-border-divider-default, #7d8998)',
        borderRadius: 10,
        padding: 14,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        boxShadow: '0 2px 6px rgb(0 0 0 / 0.10)',
      }}
    >
      <SpaceBetween size="s">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Box variant="strong">{vpc.name || vpc.vpcId}</Box>
          {vpc.isDefault && <Badge color="grey">default</Badge>}
        </SpaceBetween>
        <Box color="text-body-secondary" fontSize="body-s">
          {vpc.cidrBlock} · {vpc.subnets.length} subnets
        </Box>
      </SpaceBetween>
    </div>
  );
}
