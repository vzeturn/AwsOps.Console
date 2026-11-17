import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Badge from '@cloudscape-design/components/badge';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import {
  parseSecurityGroupIngressRule,
  parseSecurityGroupEgressRule,
  buildSecurityImpactWarning,
  buildEgressSecurityImpactWarning,
  wellKnownPortLabel,
} from '@ops-dashboard/shared';
import type { SecurityGroupRuleView, SecurityGroupSummary, SecurityGroupsResponse } from '@ops-dashboard/shared';
import { useSecurityGroups, useSecurityGroupAction } from '../hooks/useApi';
import { useActionDialog } from '../hooks/useActionDialog';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/security-groups')({
  component: SecurityGroupsPage,
});

/** A rule "wide open to the internet" — CIDR is exactly `0.0.0.0/0` (every IPv4 address). Used
 * for the exposure-risk summary at the top of the page, the same signal `buildSecurityImpactWarning`
 * already flags per-rule when adding a new one — surfaced here in aggregate for the EXISTING rules
 * an operator hasn't touched yet, so risk that's already live is visible without expanding every group. */
function isWideOpen(rule: SecurityGroupRuleView): boolean {
  return rule.cidrIp === '0.0.0.0/0';
}

/** Counts, across every group's ingress rules, how many are wide-open (any port) vs. wide-open on
 * a sensitive port (SSH/RDP/etc. — the highest-risk combination: reachable from anywhere AND a
 * management port an attacker would specifically look for). */
function useExposureSummary(data: SecurityGroupsResponse | undefined) {
  return useMemo(() => {
    const groups = data?.groups ?? [];
    let wideOpenRules = 0;
    let sensitiveWideOpenRules = 0;
    for (const group of groups) {
      for (const rule of group.ingressRules) {
        if (!isWideOpen(rule)) continue;
        wideOpenRules += 1;
        if (rule.fromPort != null && rule.toPort != null) {
          for (let port = rule.fromPort; port <= rule.toPort; port += 1) {
            if (wellKnownPortLabel(port)) {
              sensitiveWideOpenRules += 1;
              break;
            }
          }
        }
      }
    }
    return { groupCount: groups.length, wideOpenRules, sensitiveWideOpenRules };
  }, [data]);
}

type Direction = 'ingress' | 'egress';

interface AddRuleState {
  groupId: string;
  direction: Direction;
  protocol: SelectProps.Option;
  fromPort: string;
  toPort: string;
  cidrIp: string;
  description: string;
  confirmGroupId: string;
}

const PROTOCOL_OPTIONS: SelectProps.Option[] = [
  { value: 'tcp', label: 'tcp' },
  { value: 'udp', label: 'udp' },
  { value: 'icmp', label: 'icmp' },
];

function emptyAddRuleState(groupId: string, direction: Direction): AddRuleState {
  return {
    groupId,
    direction,
    protocol: PROTOCOL_OPTIONS[0],
    fromPort: '',
    toPort: '',
    cidrIp: '',
    description: '',
    confirmGroupId: '',
  };
}

function RuleTable({
  rules,
  direction,
  onRemove,
  removing,
}: {
  rules: SecurityGroupRuleView[];
  direction: Direction;
  onRemove: (rule: SecurityGroupRuleView) => void;
  removing: boolean;
}) {
  return (
    <Table<SecurityGroupRuleView>
      variant="embedded"
      items={rules}
      trackBy={(item: SecurityGroupRuleView) =>
        item.ruleId ?? `${direction}-${item.protocol}-${item.fromPort}-${item.toPort}-${item.sourceLabel}`
      }
      columnDefinitions={[
        { id: 'protocol', header: 'Protocol', cell: (item) => item.protocol },
        {
          id: 'ports',
          header: 'Port range',
          cell: (item) => (item.fromPort === item.toPort ? String(item.fromPort ?? 'all') : `${item.fromPort}-${item.toPort}`),
        },
        {
          id: 'source',
          header: 'Source',
          cell: (item) => (
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <Box variant="samp">{item.sourceLabel}</Box>
              {isWideOpen(item) && <Badge color="severity-high">public</Badge>}
            </SpaceBetween>
          ),
        },
        { id: 'description', header: 'Description', cell: (item) => item.description ?? '—' },
        {
          id: 'actions',
          header: '',
          cell: (item) => (
            <Button
              variant="inline-link"
              disabled={!item.removable || removing}
              onClick={() => onRemove(item)}
            >
              Remove
            </Button>
          ),
        },
      ]}
      empty={<Box textAlign="center">No {direction} rules.</Box>}
    />
  );
}

interface CreateGroupState {
  groupName: string;
  description: string;
  vpcId: string;
}

function SecurityGroupsPage() {
  const securityGroups = useSecurityGroups();
  const action = useSecurityGroupAction();
  const [addRule, setAddRule] = useState<AddRuleState | null>(null);
  const [formError, setFormError] = useState<string | undefined>();
  const [pendingWarning, setPendingWarning] = useState<string | undefined>();
  const [createGroup, setCreateGroup] = useState<CreateGroupState | null>(null);
  const createDialog = useActionDialog(action);
  const deleteDialog = useActionDialog(action);
  const exposure = useExposureSummary(securityGroups.data);

  const groups = securityGroups.data?.groups ?? [];

  function submitCreateGroup() {
    if (!createGroup?.groupName || !createGroup.description || !createGroup.vpcId) return;
    createDialog.open({
      actionType: 'SecurityGroup_Create',
      // No real id exists yet — matches the router's own 'pending' placeholder convention (see
      // backend/src/handlers/actions-security-group.ts).
      resourceId: 'pending',
      params: { groupName: createGroup.groupName, description: createGroup.description, vpcId: createGroup.vpcId },
      title: `Create security group — ${createGroup.groupName}`,
    });
    setCreateGroup(null);
  }

  function submitAddRule() {
    if (!addRule) return;
    setFormError(undefined);

    const rawParams = {
      protocol: addRule.protocol.value,
      fromPort: addRule.fromPort,
      toPort: addRule.toPort,
      cidrIp: addRule.cidrIp,
      description: addRule.description || undefined,
    };

    const actionType = addRule.direction === 'ingress' ? 'SecurityGroup_AuthorizeIngress' : 'SecurityGroup_AuthorizeEgress';
    const parsed =
      addRule.direction === 'ingress'
        ? parseSecurityGroupIngressRule(rawParams)
        : parseSecurityGroupEgressRule({
            protocol: String(rawParams.protocol ?? ''),
            fromPort: String(rawParams.fromPort ?? ''),
            toPort: String(rawParams.toPort ?? ''),
            cidrIp: String(rawParams.cidrIp ?? ''),
            ...(rawParams.description ? { description: rawParams.description } : {}),
          });

    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }

    const warning =
      addRule.direction === 'ingress'
        ? buildSecurityImpactWarning(actionType, parsed.rule)
        : buildEgressSecurityImpactWarning(actionType as 'SecurityGroup_AuthorizeEgress', parsed.rule);

    // A rule that opens broad/sensitive access requires typing the exact group id before it can be
    // confirmed — same friction level the shared contract requires for an irreversible action.
    if (warning && addRule.confirmGroupId !== addRule.groupId) {
      setPendingWarning(warning);
      return;
    }

    action.mutate(
      {
        actionType,
        resourceId: addRule.groupId,
        // Left empty on purpose: the router (`actions-security-group.ts`) falls back to
        // `config.awsRegion` for any empty/missing region, and this dashboard operates on exactly
        // one region — see the AWS access steering note for this project's `abc-prod-mfa` account.
        region: '',
        params: {
          protocol: parsed.rule.protocol,
          fromPort: parsed.rule.fromPort,
          toPort: parsed.rule.toPort,
          cidrIp: parsed.rule.cidrIp,
          ...(parsed.rule.description ? { description: parsed.rule.description } : {}),
        },
      },
      { onSuccess: () => setAddRule(null) },
    );
  }

  function removeRule(group: SecurityGroupSummary, direction: Direction, rule: SecurityGroupRuleView) {
    if (!rule.cidrIp || rule.fromPort === null || rule.toPort === null) return;
    const actionType = direction === 'ingress' ? 'SecurityGroup_RevokeIngress' : 'SecurityGroup_RevokeEgress';
    action.mutate({
      actionType,
      resourceId: group.groupId,
      region: '',
      params: {
        protocol: rule.protocol,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        cidrIp: rule.cidrIp,
        ...(rule.description ? { description: rule.description } : {}),
      },
    });
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <Button
              variant="primary"
              onClick={() => setCreateGroup({ groupName: '', description: '', vpcId: '' })}
            >
              Create security group
            </Button>
          }
        >
          Security Groups
        </Header>
      }
    >
      <SpaceBetween size="l">
        {securityGroups.isError && (
          <Alert type="error" header="Failed to load Security Groups">
            {(securityGroups.error as Error).message}
          </Alert>
        )}
        {securityGroups.data?.truncated && (
          <Alert type="warning" header="List truncated">
            The number of Security Groups exceeds the listing cap — some groups are not shown.
          </Alert>
        )}
        {action.isError && (
          <Alert type="error" header="Action failed">
            {(action.error as Error).message}
          </Alert>
        )}

        {!securityGroups.isLoading && securityGroups.data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <KpiTileRow>
                <KpiTile label="Security groups" value={String(exposure.groupCount)} />
                <KpiTile
                  label="Rules open to 0.0.0.0/0"
                  value={String(exposure.wideOpenRules)}
                  severity={exposure.wideOpenRules > 0 ? 'warning' : 'ok'}
                />
                <KpiTile
                  label="Sensitive ports open to internet"
                  value={String(exposure.sensitiveWideOpenRules)}
                  severity={exposure.sensitiveWideOpenRules > 0 ? 'critical' : 'ok'}
                />
              </KpiTileRow>
            </Box>
          </Container>
        )}

        {groups.map((group) => (
          <ExpandableSection
            key={group.groupId}
            variant="container"
            headerText={`${group.groupName} (${group.groupId})`}
            headerDescription={group.description}
            headerCounter={`vpc: ${group.vpcId}`}
            headerActions={
              <Button
                variant="normal"
                onClick={() =>
                  deleteDialog.open({
                    actionType: 'SecurityGroup_Delete',
                    resourceId: group.groupId,
                    title: `Delete security group — ${group.groupName}`,
                  })
                }
              >
                Delete
              </Button>
            }
          >
            <SpaceBetween size="m">
              <ExpandableSection
                variant="inline"
                headerText={`Inbound rules (${group.ingressRules.length})`}
                headerActions={
                  <Button onClick={() => setAddRule(emptyAddRuleState(group.groupId, 'ingress'))}>Add rule</Button>
                }
                defaultExpanded
              >
                <RuleTable
                  rules={group.ingressRules}
                  direction="ingress"
                  removing={action.isPending}
                  onRemove={(rule) => removeRule(group, 'ingress', rule)}
                />
              </ExpandableSection>
              <ExpandableSection
                variant="inline"
                headerText={`Outbound rules (${group.egressRules.length})`}
                headerActions={
                  <Button onClick={() => setAddRule(emptyAddRuleState(group.groupId, 'egress'))}>Add rule</Button>
                }
              >
                <RuleTable
                  rules={group.egressRules}
                  direction="egress"
                  removing={action.isPending}
                  onRemove={(rule) => removeRule(group, 'egress', rule)}
                />
              </ExpandableSection>
            </SpaceBetween>
          </ExpandableSection>
        ))}
        {!securityGroups.isLoading && groups.length === 0 && (
          <Box textAlign="center" padding="l">
            No Security Groups found.
          </Box>
        )}
      </SpaceBetween>

      <Modal
        visible={addRule !== null}
        onDismiss={() => {
          setAddRule(null);
          setFormError(undefined);
          setPendingWarning(undefined);
        }}
        header={addRule ? `Add ${addRule.direction} rule — ${addRule.groupId}` : ''}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setAddRule(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={action.isPending}
                disabled={Boolean(pendingWarning) && addRule?.confirmGroupId !== addRule?.groupId}
                onClick={submitAddRule}
              >
                Add rule
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {addRule && (
          <SpaceBetween size="m">
            {formError && <Alert type="error">{formError}</Alert>}
            {pendingWarning && <Alert type="warning">{pendingWarning}</Alert>}
            <FormField label="Protocol">
              <Select
                selectedOption={addRule.protocol}
                options={PROTOCOL_OPTIONS}
                onChange={(event: { detail: SelectProps.ChangeDetail }) =>
                  setAddRule({ ...addRule, protocol: event.detail.selectedOption })
                }
              />
            </FormField>
            <FormField label="From port" description="Use -1 for icmp (any type).">
              <Input
                value={addRule.fromPort}
                inputMode="numeric"
                onChange={(event: { detail: { value: string } }) => setAddRule({ ...addRule, fromPort: event.detail.value })}
              />
            </FormField>
            <FormField label="To port">
              <Input
                value={addRule.toPort}
                inputMode="numeric"
                onChange={(event: { detail: { value: string } }) => setAddRule({ ...addRule, toPort: event.detail.value })}
              />
            </FormField>
            <FormField label="Source CIDR" description="IPv4 CIDR, e.g. 10.0.0.0/24 or 0.0.0.0/0.">
              <Input
                value={addRule.cidrIp}
                onChange={(event: { detail: { value: string } }) => setAddRule({ ...addRule, cidrIp: event.detail.value })}
              />
            </FormField>
            <FormField label="Description (optional)">
              <Input
                value={addRule.description}
                onChange={(event: { detail: { value: string } }) => setAddRule({ ...addRule, description: event.detail.value })}
              />
            </FormField>
            {pendingWarning && (
              <FormField label="Type the Security Group id to confirm" description={addRule.groupId}>
                <Input
                  value={addRule.confirmGroupId}
                  onChange={(event: { detail: { value: string } }) =>
                    setAddRule({ ...addRule, confirmGroupId: event.detail.value })
                  }
                />
              </FormField>
            )}
          </SpaceBetween>
        )}
      </Modal>

      <Modal
        visible={createGroup !== null}
        onDismiss={() => setCreateGroup(null)}
        header="Create security group"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setCreateGroup(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!createGroup?.groupName || !createGroup.description || !createGroup.vpcId}
                onClick={submitCreateGroup}
              >
                Next
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {createGroup && (
          <SpaceBetween size="m">
            <FormField label="Group name">
              <Input
                value={createGroup.groupName}
                onChange={(event: { detail: { value: string } }) => setCreateGroup({ ...createGroup, groupName: event.detail.value })}
              />
            </FormField>
            <FormField label="Description">
              <Input
                value={createGroup.description}
                onChange={(event: { detail: { value: string } }) => setCreateGroup({ ...createGroup, description: event.detail.value })}
              />
            </FormField>
            <FormField label="VPC ID" description="e.g. vpc-0123456789abcdef0">
              <Input
                value={createGroup.vpcId}
                onChange={(event: { detail: { value: string } }) => setCreateGroup({ ...createGroup, vpcId: event.detail.value })}
              />
            </FormField>
          </SpaceBetween>
        )}
      </Modal>

      <ConfirmationDialog {...createDialog.dialogProps} />
      <ConfirmationDialog {...deleteDialog.dialogProps} />
    </ContentLayout>
  );
}
