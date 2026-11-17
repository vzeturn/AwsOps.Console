import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Popover from '@cloudscape-design/components/popover';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import type { ThresholdMeta, TopologyResource, TopologyResourceKind } from '@ops-dashboard/shared';
import { statusIndicatorType } from '../../lib/thresholdStatus';
import { AwsResourceIcon } from '../AwsResourceIcon';

/**
 * `AccountResourceGroupBox` — reuses the old hand-built `ResourceGroupBox`/`ResourceChip` JSX
 * verbatim for the "Account-level resources" (S3/TGW) and "Unplaced resources" sections. These are
 * DELIBERATELY kept OUTSIDE the `<ReactFlow>` canvas/ELK layout (unchanged from the old
 * `InfraNetworkDiagram`'s `accountLevelSection`, rendered as a sibling of the VPC diagram, not a
 * node inside it) — they are not scoped to any one VPC's graph the way a subnet's resources are
 * (design.md's Architecture section; `shared/src/index.ts`'s own doc comment on
 * `TopologyData.accountResources` explains why S3/TGW have no VPC-scoped edges to lay out against
 * in the first place).
 *
 * The plain `ResourceChip`-equivalent rendering here is INTENTIONALLY duplicated from
 * `nodes/ResourceNode.tsx` rather than shared: `ResourceNode` is a React Flow node component
 * (receives `NodeProps`, sized by the Node's `style`), this one is a plain flex-wrapped Cloudscape
 * layout (sized by its own content) — forcing one shape to serve both would need an artificial
 * adapter for no real benefit, since the two render contexts differ structurally, not just in styling.
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

function AccountResourceChip({
  resource,
  health,
  onClick,
}: {
  resource: TopologyResource;
  health: Map<string, ThresholdMeta>;
  onClick: (resource: TopologyResource) => void;
}) {
  const threshold = health.get(resource.id);
  const clickable = Boolean(resource.monitoringType);

  return (
    <Popover triggerType="custom" position="top" size="medium" header={resource.name} content={<ResourceTooltip resource={resource} threshold={threshold} />}>
      <div
        className="infra-map-resource-chip"
        data-clickable={clickable}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-label={clickable ? `Open ${resource.name} details` : undefined}
        onClick={clickable ? () => onClick(resource) : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onClick(resource);
                }
              }
            : undefined
        }
        style={{
          opacity: clickable ? 1 : 0.75, // Requirement 5.2, same static pre-hover affordance as ResourceNode.
          cursor: clickable ? 'pointer' : 'default',
          border: '1px solid var(--awsui-color-border-divider-default, #7d8998)',
          borderRadius: 6,
          background: 'var(--awsui-color-background-container-content, transparent)',
          padding: '6px 10px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 150,
        }}
      >
        <AwsResourceIcon kind={resource.kind} size={26} />
        <SpaceBetween size="xxs">
          <Box variant="samp" fontSize="body-s">
            {resource.name}
          </Box>
          <StatusIndicator type={threshold ? statusIndicatorType(threshold.level) : 'info'}>
            {threshold ? threshold.level : 'unmonitored'}
          </StatusIndicator>
        </SpaceBetween>
      </div>
    </Popover>
  );
}

export interface AccountResourceGroupBoxProps {
  /** DOM element id — the "Unplaced resources" instance gets `infra-map-unplaced-section`
   * (Requirement 1.2's scroll+highlight target, wired in Task 6); the "Account-level resources"
   * instance passes none, since no KPI tile drills down to it. */
  id?: string;
  title: string;
  description: string;
  resources: TopologyResource[];
  health: Map<string, ThresholdMeta>;
  onResourceClick: (resource: TopologyResource) => void;
  accentColor: string;
  warning?: boolean;
}

export function AccountResourceGroupBox({
  id,
  title,
  description,
  resources,
  health,
  onResourceClick,
  accentColor,
  warning,
}: AccountResourceGroupBoxProps) {
  return (
    <div id={id} style={{ border: `1px solid ${accentColor}`, borderRadius: 10, padding: 14, minWidth: 260 }}>
      <SpaceBetween size="s">
        <Box fontWeight="bold" color={warning ? 'text-status-warning' : undefined}>
          {title}
        </Box>
        <Box color="text-body-secondary" fontSize="body-s">
          {description}
        </Box>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {resources.map((r) => (
            <AccountResourceChip key={r.id} resource={r} health={health} onClick={onResourceClick} />
          ))}
        </div>
      </SpaceBetween>
    </div>
  );
}
