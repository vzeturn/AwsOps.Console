import type { NodeProps } from '@xyflow/react';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Popover from '@cloudscape-design/components/popover';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import type { ThresholdMeta, TopologyResource, TopologyResourceKind } from '@ops-dashboard/shared';
import { statusIndicatorType } from '../../../lib/thresholdStatus';
import { AwsResourceIcon } from '../../AwsResourceIcon';

/**
 * `ResourceNode` — the React Flow custom node type `'resource'`. Reuses the EXACT same
 * icon/tooltip/status-indicator JSX the old hand-built `ResourceChip` used (see
 * `InfraNetworkDiagram.tsx`'s original `ResourceChip`/`ResourceTooltip` for the piece this was
 * copied from) — only the data source changed, from direct component props to React Flow's own
 * injected `data` prop (design.md's "Custom node components" section).
 *
 * Sizing: the outer `div` fills 100% of the box React Flow itself sizes from the Node's `style`
 * (set by `elkLayoutAdapter.ts`'s `estimateResourceNodeWidth`) — no hardcoded `minWidth`/padding
 * here (Requirement 5.1), unlike the old `ResourceChip`'s flat `minWidth: 150`.
 */
const KIND_LABEL: Record<TopologyResourceKind, string> = {
  ec2: 'EC2 instance',
  rds: 'RDS instance',
  alb: 'Application Load Balancer',
  nlb: 'Network Load Balancer',
  ecs: 'ECS service',
  natgw: 'NAT Gateway',
  s3: 'S3 bucket',
  tgw: 'Transit Gateway',
};

function ResourceTooltip({ resource, threshold }: { resource: TopologyResource; threshold?: ThresholdMeta }) {
  return (
    <KeyValuePairs
      columns={1}
      items={[
        { label: 'Type', value: KIND_LABEL[resource.kind] },
        { label: 'State', value: resource.detail ?? resource.state },
        ...(resource.availabilityZone ? [{ label: 'Availability zone', value: resource.availabilityZone }] : []),
        {
          label: 'Health',
          value: (
            <StatusIndicator type={threshold ? statusIndicatorType(threshold.level) : 'info'}>
              {threshold ? threshold.level : 'unmonitored'}
            </StatusIndicator>
          ),
        },
        ...(threshold ? [{ label: 'Reason', value: threshold.reason }] : []),
      ]}
    />
  );
}

export interface ResourceNodeData {
  resource: TopologyResource;
  threshold: ThresholdMeta | undefined;
  onResourceClick: (resource: TopologyResource) => void;
  // React Flow's own `Node<T>` generic constrains `T` to `Record<string, unknown>` — this index
  // signature satisfies that constraint so `ResourceNodeData` can be used directly as a `Node`'s
  // `data` (VpcDiagramCanvas.tsx), instead of needing a cast at every call site.
  [key: string]: unknown;
}

export function ResourceNode({ data }: NodeProps & { data: ResourceNodeData }) {
  const { resource, threshold, onResourceClick } = data;
  const clickable = Boolean(resource.monitoringType);

  return (
    <Popover
      triggerType="custom"
      position="top"
      size="medium"
      header={resource.name}
      content={<ResourceTooltip resource={resource} threshold={threshold} />}
    >
      <div
        className="infra-map-resource-chip"
        data-clickable={clickable}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? `Open ${resource.name} details` : undefined}
        onClick={clickable ? () => onResourceClick(resource) : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onResourceClick(resource);
                }
              }
            : undefined
        }
        style={{
          // Requirement 5.2: a NON-clickable node (nlb/natgw/s3/tgw — never has a `monitoringType`,
          // see shared/src/index.ts) gets a static, always-visible dimming, not only a `:hover`
          // difference — the old code only differed on `:hover` (index.css's
          // `[data-clickable='true']:hover` rule), giving no signal before a reader actually
          // hovers over it.
          opacity: clickable ? 1 : 0.75,
          cursor: clickable ? 'pointer' : 'default',
          border: '1px solid var(--awsui-color-border-divider-default, #7d8998)',
          borderRadius: 6,
          background: 'var(--awsui-color-background-container-content, transparent)',
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        <AwsResourceIcon kind={resource.kind} size={26} />
        <SpaceBetween size="xxs">
          <Box variant="samp" fontSize="body-s" data-testid="resource-node-name">
            <span
              style={{
                display: 'block',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              // The FULL name is still available via the Popover's own header above (Requirement
              // 5.1's "accessible affordance" clause) — this truncation is purely visual.
              title={resource.name}
            >
              {resource.name}
            </span>
          </Box>
          <StatusIndicator type={threshold ? statusIndicatorType(threshold.level) : 'info'}>
            {threshold ? threshold.level : 'unmonitored'}
          </StatusIndicator>
        </SpaceBetween>
      </div>
    </Popover>
  );
}
