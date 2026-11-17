import type { NodeProps } from '@xyflow/react';
import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import SpaceBetween from '@cloudscape-design/components/space-between';
import type { TopologySubnet } from '@ops-dashboard/shared';
import { TIER_ACCENT } from '../diagramTheme';

/**
 * `SubnetGroupNode` — React Flow custom node type `'subnetGroup'`. Reuses the same header/badge/
 * CIDR-AZ-IP-count label JSX the old hand-built `SubnetBox` used. Like `VpcGroupNode`, the
 * RESOURCES inside this subnet are separate React Flow nodes (`parentId` = this subnet's id, per
 * `elkLayoutAdapter.ts`) — this component renders only the subnet's own header chrome, ELK/React
 * Flow handle the resource grid's actual layout.
 *
 * Depth_Tier 1 background (Requirement 2.1/2.2): `--awsui-color-background-visual-accent-grey`, a
 * real Cloudscape semantic token resolving to a genuinely distinct step from Depth_Tier 0's
 * `container-content` in BOTH themes (`#ebebf0` light / `#333843` dark vs. `#ffffff`/`#161d26`) —
 * confirmed by reading the actual compiled values out of a `vite build` output rather than
 * assumed; see `diagramTheme.ts`'s own top-of-file comment for the full verification.
 */
export interface SubnetGroupNodeData {
  subnet: TopologySubnet;
  // Satisfies React Flow's `Node<T>` generic constraint (`T extends Record<string, unknown>`) —
  // see the same note on `ResourceNodeData` in `ResourceNode.tsx`.
  [key: string]: unknown;
}

export function SubnetGroupNode({ data }: NodeProps & { data: SubnetGroupNodeData }) {
  const { subnet } = data;
  return (
    <div
      className="infra-map-subnet-box"
      style={{
        border: '1px solid var(--awsui-color-border-divider-default, #7d8998)',
        borderTop: `3px solid ${TIER_ACCENT[subnet.tier]}`,
        borderRadius: 6,
        padding: 10,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      <SpaceBetween size="xs">
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <Box fontWeight="bold" fontSize="body-s">
            {subnet.name || subnet.subnetId}
          </Box>
          <Badge color={subnet.tier === 'public' ? 'blue' : subnet.tier === 'private' ? 'grey' : 'green'}>{subnet.tier}</Badge>
        </SpaceBetween>
        <Box color="text-body-secondary" fontSize="body-s">
          {subnet.cidrBlock} · {subnet.availabilityZone} · {subnet.availableIpCount} IPs free
        </Box>
      </SpaceBetween>
    </div>
  );
}
