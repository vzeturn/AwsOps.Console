import { useMemo } from 'react';
import Box from '@cloudscape-design/components/box';
import Tabs from '@cloudscape-design/components/tabs';
import '@xyflow/react/dist/style.css';
import type { ThresholdMeta, TopologyData, TopologyResource } from '@ops-dashboard/shared';
import { VpcDiagramCanvas } from './VpcDiagramCanvas';
import { AccountResourceGroupBox } from './AccountResourceGroupBox';
import { DiagramLegend } from './DiagramLegend';

/**
 * `InfraNetworkDiagram` — a real visual network diagram: nested VPC/subnet boxes with resource
 * nodes, and edges drawn between them, laid out by `elkjs`'s `layered` algorithm and rendered by
 * `@xyflow/react` (React Flow). Replaces the previous hand-built version (plain positioned `div`s
 * measured via `getBoundingClientRect()`, plus a raw SVG overlay for edges — see
 * `elkLayoutAdapter.ts`'s and `VpcDiagramCanvas.tsx`'s doc comments for why a library, and why
 * these two specifically, were chosen over continuing to hand-roll it).
 *
 * Public props are UNCHANGED from the old implementation (`InfraNetworkDiagramProps`) — this is a
 * rendering-internals swap, not a contract change, so `infra-map.tsx` (the route that renders
 * this) needs no changes to keep working.
 *
 * Multiple VPCs are shown one at a time via `Tabs`, exactly as before: with several VPCs stacked
 * vertically, an operator would have to scroll past every other VPC to reach the one they actually
 * want; a tab per VPC turns that into a single click. Exactly one VPC skips the tab strip
 * entirely, since there is nothing to switch between.
 */
export interface InfraNetworkDiagramProps {
  data: TopologyData;
  health: Map<string, ThresholdMeta>;
  onResourceClick: (resource: TopologyResource) => void;
}

export function InfraNetworkDiagram({ data, health, onResourceClick }: InfraNetworkDiagramProps) {
  const resourcesBySubnet = useMemo(() => {
    const map = new Map<string, TopologyResource[]>();
    for (const resource of data.resources) {
      for (const subnetId of resource.subnetIds) {
        const list = map.get(subnetId) ?? [];
        list.push(resource);
        map.set(subnetId, list);
      }
    }
    return map;
  }, [data.resources]);

  const hasAccountResources = (data.accountResources?.length ?? 0) > 0;
  const hasUnplaced = data.unplacedResources.length > 0;

  if (data.vpcs.length === 0 && !hasAccountResources && !hasUnplaced) {
    return (
      <Box textAlign="center" color="text-body-secondary" padding="l">
        No topology data yet.
      </Box>
    );
  }

  const accountLevelSection = (hasAccountResources || hasUnplaced) && (
    <Box padding={{ top: 'l' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, justifyContent: 'center' }}>
        {hasAccountResources && (
          <AccountResourceGroupBox
            title="Account-level resources"
            description="S3 buckets and Transit Gateways — not scoped to one VPC."
            resources={data.accountResources ?? []}
            health={health}
            onResourceClick={onResourceClick}
            accentColor="var(--awsui-color-border-divider-default, #7d8998)"
          />
        )}
        {hasUnplaced && (
          <AccountResourceGroupBox
            id="infra-map-unplaced-section"
            title="Unplaced resources"
            description="VPC/subnet could not be resolved — verify these are not orphaned."
            resources={data.unplacedResources}
            health={health}
            onResourceClick={onResourceClick}
            accentColor="#f59e0b"
            warning
          />
        )}
      </div>
    </Box>
  );

  if (data.vpcs.length <= 1) {
    return (
      <div>
        <DiagramLegend />
        {data.vpcs.length === 1 && (
          <VpcDiagramCanvas
            vpc={data.vpcs[0]}
            resourcesBySubnet={resourcesBySubnet}
            health={health}
            onResourceClick={onResourceClick}
            edges={data.edges}
          />
        )}
        {accountLevelSection}
      </div>
    );
  }

  return (
    <div>
      <DiagramLegend />
      <Tabs
        tabs={data.vpcs.map((vpc) => {
          const resourceCount = vpc.subnets.reduce((sum, s) => sum + (resourcesBySubnet.get(s.subnetId)?.length ?? 0), 0);
          return {
            id: vpc.vpcId,
            label: `${vpc.name || vpc.vpcId} (${resourceCount})`,
            content: (
              <VpcDiagramCanvas
                vpc={vpc}
                resourcesBySubnet={resourcesBySubnet}
                health={health}
                onResourceClick={onResourceClick}
                edges={data.edges}
              />
            ),
          };
        })}
      />
      {accountLevelSection}
    </div>
  );
}
