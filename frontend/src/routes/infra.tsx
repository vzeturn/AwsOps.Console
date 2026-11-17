import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import Tabs from '@cloudscape-design/components/tabs';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import type { ButtonDropdownProps } from '@cloudscape-design/components/button-dropdown';
import Modal from '@cloudscape-design/components/modal';
import Button from '@cloudscape-design/components/button';
import FormField from '@cloudscape-design/components/form-field';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import TagEditor from '@cloudscape-design/components/tag-editor';
import type { TagEditorProps } from '@cloudscape-design/components/tag-editor';
import Multiselect from '@cloudscape-design/components/multiselect';
import type { MultiselectProps } from '@cloudscape-design/components/multiselect';
import Input from '@cloudscape-design/components/input';
import { chooseEc2Action, rdsLifecycleActionsForStatus } from '@ops-dashboard/shared';
import type { AlbSummary, ActionType, Ec2Summary, InfraData, RdsSummary, ThresholdLevel } from '@ops-dashboard/shared';
import { useInfra, useMe, useEc2InstanceTypes, useActionExecute, useActionLifecycle, useActionEc2Management, useActionUpdateTags, useSecurityGroupAction, useExportCsv } from '../hooks/useApi';
import { useActionDialog } from '../hooks/useActionDialog';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { statusIndicatorType } from '../lib/thresholdStatus';
import { KpiTile, KpiTileRow } from '../components/KpiTile';
import { SeverityStatusBar } from '../components/SeverityStatusBar';

export const Route = createFileRoute('/infra')({
  component: InfraPage,
});

/** Severity counts + a couple of fleet-level KPIs across EC2/RDS/ALB combined — the "how is the
 * whole fleet doing" summary above the per-resource-type tabs. */
function useInfraSummary(data: InfraData | undefined) {
  return useMemo(() => {
    const levels: ThresholdLevel[] = [
      ...(data?.ec2 ?? []).map((i) => i.threshold.level),
      ...(data?.rds ?? []).map((i) => i.threshold.level),
      ...(data?.alb ?? []).map((i) => i.threshold.level),
    ];
    const counts = { critical: 0, warn: 0, ok: 0 };
    for (const level of levels) {
      if (level === 'critical') counts.critical += 1;
      else if (level === 'warn') counts.warn += 1;
      else counts.ok += 1;
    }
    const runningEc2 = (data?.ec2 ?? []).filter((i) => i.state === 'running').length;
    return {
      counts,
      total: levels.length,
      runningEc2,
      totalEc2: data?.ec2.length ?? 0,
    };
  }, [data]);
}

/** EC2 row actions reachable from `POST /actions/execute` (general gate) — Start/Stop always
 * shows exactly one, per `chooseEc2Action()` (shared/src/action-catalog.ts). `EC2_Rightsize` also
 * runs through the general gate (see ACTION_CATALOG). */
function ec2GeneralActions(instance: Ec2Summary): ButtonDropdownProps.Item[] {
  const startStop = chooseEc2Action(instance.state);
  const items: ButtonDropdownProps.Item[] = [
    { id: startStop, text: startStop === 'EC2_Start' ? 'Start' : 'Stop' },
  ];
  if (instance.state === 'running') {
    items.push({ id: 'EC2_Rightsize', text: 'Rightsize (downsize one step)' });
  }
  return items;
}

function InfraPage() {
  const infra = useInfra();
  const me = useMe();
  const exportCsv = useExportCsv();
  const data = infra.data;
  const isOperator = me.data?.isOperator ?? false;
  const summary = useInfraSummary(data);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <Button loading={exportCsv.isPending} onClick={() => exportCsv.mutate('infra')}>
              Export CSV
            </Button>
          }
        >
          Infrastructure
        </Header>
      }
    >
      <SpaceBetween size="l">
        {infra.isError && (
          <Alert type="error" header="Failed to load infrastructure data">
            {(infra.error as Error).message}
          </Alert>
        )}
        {!me.isLoading && !isOperator && (
          <Alert type="info">
            Read-only view — reboot, RDS start/stop, instance type, and tag changes require operator
            permission. Start/Stop/Rightsize actions are still available to every signed-in user.
          </Alert>
        )}
        {!infra.isLoading && data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <SpaceBetween size="m">
                <SeverityStatusBar counts={summary.counts} />
                <KpiTileRow>
                  <KpiTile label="EC2 running" value={`${summary.runningEc2} / ${summary.totalEc2}`} />
                  <KpiTile label="RDS instances" value={String(data.rds.length)} />
                  <KpiTile label="Load balancers" value={String(data.alb.length)} />
                  <KpiTile label="Resources tracked" value={String(summary.total)} />
                </KpiTileRow>
              </SpaceBetween>
            </Box>
          </Container>
        )}
        <Tabs
          tabs={[
            {
              id: 'ec2',
              label: `EC2${data ? ` (${data.ec2.length})` : ''}`,
              content: <Ec2Table items={data?.ec2 ?? []} loading={infra.isLoading} isOperator={isOperator} />,
            },
            {
              id: 'rds',
              label: `RDS${data ? ` (${data.rds.length})` : ''}`,
              content: <RdsTable items={data?.rds ?? []} loading={infra.isLoading} isOperator={isOperator} />,
            },
            {
              id: 'alb',
              label: `ALB${data ? ` (${data.alb.length})` : ''}`,
              content: <AlbTable items={data?.alb ?? []} loading={infra.isLoading} />,
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

function Ec2Table({ items, loading, isOperator }: { items: Ec2Summary[]; loading: boolean; isOperator: boolean }) {
  const generalExecute = useActionExecute();
  const lifecycle = useActionLifecycle();
  const generalDialog = useActionDialog(generalExecute);
  const lifecycleDialog = useActionDialog(lifecycle);

  const [changeTypeInstance, setChangeTypeInstance] = useState<Ec2Summary | undefined>();
  const [tagsInstance, setTagsInstance] = useState<Ec2Summary | undefined>();
  const [sgInstance, setSgInstance] = useState<Ec2Summary | undefined>();

  function handleAction(instance: Ec2Summary, actionId: string) {
    switch (actionId) {
      case 'EC2_Start':
      case 'EC2_Stop':
        generalDialog.open({
          actionType: actionId as ActionType,
          resourceId: instance.instanceId,
          region: instance.region,
          title: `${actionId === 'EC2_Start' ? 'Start' : 'Stop'} ${instance.name}`,
        });
        break;
      case 'EC2_Rightsize':
        generalDialog.open({
          actionType: 'EC2_Rightsize',
          resourceId: instance.instanceId,
          region: instance.region,
          title: `Rightsize ${instance.name}`,
        });
        break;
      case 'EC2_Reboot':
        lifecycleDialog.open({
          actionType: 'EC2_Reboot',
          resourceId: instance.instanceId,
          region: instance.region,
          title: `Reboot ${instance.name}`,
        });
        break;
      case 'Ec2_ChangeInstanceType':
        setChangeTypeInstance(instance);
        break;
      case 'Ec2_UpdateTags':
        setTagsInstance(instance);
        break;
      case 'Ec2_ModifySecurityGroups':
        setSgInstance(instance);
        break;
    }
  }

  return (
    <>
      <Table<Ec2Summary>
        variant="borderless"
        loading={loading}
        items={items}
        trackBy="instanceId"
        columnDefinitions={[
          {
            id: 'status',
            header: 'Status',
            width: 120,
            cell: (item) => <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.state}</StatusIndicator>,
          },
          { id: 'name', header: 'Name', cell: (item) => item.name },
          {
            id: 'instanceId',
            header: 'Instance ID',
            cell: (item) => <Box variant="samp">{item.instanceId}</Box>,
          },
          { id: 'type', header: 'Instance type', cell: (item) => item.instanceType },
          { id: 'region', header: 'Region', cell: (item) => item.region },
          {
            id: 'actions',
            header: '',
            cell: (item) => (
              <ButtonDropdown
                items={[
                  ...ec2GeneralActions(item),
                  {
                    id: 'operator-group',
                    text: 'Operator actions',
                    items: [
                      { id: 'EC2_Reboot', text: 'Reboot', disabled: !isOperator || item.state !== 'running' },
                      { id: 'Ec2_ChangeInstanceType', text: 'Change instance type…', disabled: !isOperator || item.state !== 'stopped' },
                      { id: 'Ec2_UpdateTags', text: 'Edit tags…', disabled: !isOperator },
                      { id: 'Ec2_ModifySecurityGroups', text: 'Modify security groups…', disabled: !isOperator },
                    ],
                  },
                ]}
                onItemClick={({ detail }) => handleAction(item, detail.id)}
                variant="normal"
              >
                Actions
              </ButtonDropdown>
            ),
          },
        ]}
        empty={<Box textAlign="center">No EC2 instances.</Box>}
      />
      <ConfirmationDialog {...generalDialog.dialogProps} />
      <ConfirmationDialog {...lifecycleDialog.dialogProps} />
      {changeTypeInstance && (
        <ChangeInstanceTypeModal instance={changeTypeInstance} onClose={() => setChangeTypeInstance(undefined)} />
      )}
      {tagsInstance && <UpdateTagsModal instance={tagsInstance} onClose={() => setTagsInstance(undefined)} />}
      {sgInstance && <ModifySecurityGroupsModal instance={sgInstance} onClose={() => setSgInstance(undefined)} />}
    </>
  );
}

/** `Ec2_ChangeInstanceType` — needs a live compatible-types lookup (`GET /ec2-instance-types`)
 * before the Confirmation_Dialog can even be opened, so this is its own small modal rather than a
 * direct `useActionDialog.open()` call (which assumes params are already known). */
function ChangeInstanceTypeModal({ instance, onClose }: { instance: Ec2Summary; onClose: () => void }) {
  const types = useEc2InstanceTypes(instance.instanceId);
  const ec2Management = useActionEc2Management();
  const dialog = useActionDialog(ec2Management);
  const [typeOption, setTypeOption] = useState<SelectProps.Option | null>(null);

  const typeOptions: SelectProps.Option[] = (types.data?.compatibleTypes ?? []).map((t) => ({ value: t, label: t }));

  function proceed() {
    if (!typeOption?.value) return;
    dialog.open({
      actionType: 'Ec2_ChangeInstanceType',
      resourceId: instance.instanceId,
      region: instance.region,
      params: { targetInstanceType: typeOption.value },
      title: `Change instance type — ${instance.name}`,
      extraDetails: [
        { label: 'Current type', value: instance.instanceType },
        { label: 'Target type', value: typeOption.value },
      ],
    });
  }

  if (dialog.dialogProps.visible) {
    return (
      <ConfirmationDialog
        {...dialog.dialogProps}
        onDismiss={() => {
          dialog.close();
          onClose();
        }}
      />
    );
  }

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={`Change instance type — ${instance.name}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!typeOption} loading={types.isLoading} onClick={proceed}>
              Next
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {instance.state !== 'stopped' && (
          <Alert type="warning">
            The instance is currently "{instance.state}" — it must be stopped before its type can be changed.
          </Alert>
        )}
        {types.isError && (
          <Alert type="error">{(types.error as Error).message}</Alert>
        )}
        <FormField label="Current type">
          <Box variant="samp">{instance.instanceType}</Box>
        </FormField>
        <FormField label="Target type" description="Only types compatible with this instance's architecture/AZ are listed.">
          <Select
            selectedOption={typeOption}
            options={typeOptions}
            placeholder="Choose a type"
            filteringType="auto"
            statusType={types.isLoading ? 'loading' : 'finished'}
            onChange={(event: { detail: SelectProps.ChangeDetail }) => setTypeOption(event.detail.selectedOption)}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

/** `Ec2_UpdateTags` — uses Cloudscape's own `TagEditor`, seeded with the instance's current tags
 * (`Ec2Summary.tags`), diffed into `set`/`remove` at submit time. */
function UpdateTagsModal({ instance, onClose }: { instance: Ec2Summary; onClose: () => void }) {
  const updateTags = useActionUpdateTags();
  const [tags, setTags] = useState<TagEditorProps.Tag[]>(
    Object.entries(instance.tags ?? {}).map(([key, value]) => ({ key, value, existing: true })),
  );

  function submit() {
    const set: Record<string, string> = {};
    const remove: string[] = [];
    for (const tag of tags) {
      if (tag.markedForRemoval) {
        if (tag.existing) remove.push(tag.key);
        continue;
      }
      if (tag.key) set[tag.key] = tag.value;
    }
    updateTags.mutate(
      { resourceId: instance.instanceId, region: instance.region, set, remove },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal
      visible
      onDismiss={onClose}
      size="large"
      header={`Edit tags — ${instance.name}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose} disabled={updateTags.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={updateTags.isPending} onClick={submit}>
              Save tags
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {updateTags.isError && <Alert type="error">{(updateTags.error as Error).message}</Alert>}
        <TagEditor
          tags={tags}
          onChange={(event: { detail: TagEditorProps.ChangeDetail }) => setTags([...event.detail.tags])}
          i18nStrings={{
            keyPlaceholder: 'Enter key',
            valuePlaceholder: 'Enter value',
            addButton: 'Add new tag',
            removeButton: 'Remove',
            undoButton: 'Undo',
            undoPrompt: 'This tag will be removed upon saving',
            emptyTags: 'No tags associated with this instance.',
          }}
        />
      </SpaceBetween>
    </Modal>
  );
}

/** `Ec2_ModifySecurityGroups` — full-replacement-list semantics (see `ACTION_CATALOG`'s doc
 * comment): the picker starts pre-selected with the instance's CURRENT security groups so an
 * operator edits the actual set rather than starting from empty and unintentionally dropping every
 * SG the instance previously had. Currently limited to the SGs already known on the instance's own
 * `securityGroupIds` (from `/infra`) plus manual entry isn't offered here — a full SG picker
 * would need `/security-groups` cross-referenced by VPC, deferred as a later enhancement; the
 * preview step (`ec2-modify-security-groups-service.ts`) still computes and displays the real
 * +N/-M diff before anything is confirmed. */
function ModifySecurityGroupsModal({ instance, onClose }: { instance: Ec2Summary; onClose: () => void }) {
  const sgAction = useSecurityGroupAction();
  const dialog = useActionDialog(sgAction);
  const currentIds = instance.securityGroupIds ?? [];
  const [selected, setSelected] = useState<MultiselectProps.Option[]>(
    currentIds.map((id) => ({ value: id, label: id })),
  );
  const [extraId, setExtraId] = useState('');

  const options: MultiselectProps.Option[] = Array.from(
    new Set([...currentIds, ...selected.map((o) => o.value ?? ''), extraId].filter(Boolean)),
  ).map((id) => ({ value: id, label: id }));

  function proceed() {
    const groupIds = selected.map((o) => o.value).filter((v): v is string => Boolean(v));
    if (groupIds.length === 0) return;
    dialog.open({
      actionType: 'Ec2_ModifySecurityGroups',
      resourceId: instance.instanceId,
      region: instance.region,
      params: { groupIds: JSON.stringify(groupIds) },
      title: `Modify security groups — ${instance.name}`,
    });
  }

  if (dialog.dialogProps.visible) {
    return (
      <ConfirmationDialog
        {...dialog.dialogProps}
        onDismiss={() => {
          dialog.close();
          onClose();
        }}
      />
    );
  }

  return (
    <Modal
      visible
      onDismiss={onClose}
      header={`Modify security groups — ${instance.name}`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={selected.length === 0} onClick={proceed}>
              Next
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <FormField label="Security groups" description="At least one is required. The exact +/- diff is shown on the next step.">
          <Multiselect
            selectedOptions={selected}
            options={options}
            placeholder="Choose security groups"
            onChange={(event: { detail: MultiselectProps.MultiselectChangeDetail }) => setSelected([...event.detail.selectedOptions])}
          />
        </FormField>
        <FormField
          label="Add a security group id not listed above"
          description="e.g. sg-0123456789abcdef0 — press Enter or click away to add it to the list above."
        >
          <Input
            value={extraId}
            placeholder="sg-..."
            onChange={(event: { detail: { value: string } }) => setExtraId(event.detail.value)}
            onBlur={() => {
              if (extraId && /^sg-[0-9a-f]{8,17}$/.test(extraId)) {
                setSelected((prev) => (prev.some((o) => o.value === extraId) ? prev : [...prev, { value: extraId, label: extraId }]));
                setExtraId('');
              }
            }}
          />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

function RdsTable({ items, loading, isOperator }: { items: RdsSummary[]; loading: boolean; isOperator: boolean }) {
  const generalExecute = useActionExecute();
  const lifecycle = useActionLifecycle();
  const generalDialog = useActionDialog(generalExecute);
  const lifecycleDialog = useActionDialog(lifecycle);

  function handleAction(instance: RdsSummary, actionId: string) {
    const title = `${actionId.replace('RDS_', '')} ${instance.dbInstanceIdentifier}`;
    switch (actionId) {
      case 'RDS_IncreaseStorage':
      case 'RDS_ApplyResourceGovernance':
        generalDialog.open({
          actionType: actionId as ActionType,
          resourceId: instance.dbInstanceIdentifier,
          region: instance.region,
          title,
        });
        break;
      case 'RDS_Start':
      case 'RDS_Stop':
      case 'RDS_Reboot':
        lifecycleDialog.open({
          actionType: actionId as ActionType,
          resourceId: instance.dbInstanceIdentifier,
          region: instance.region,
          title,
        });
        break;
    }
  }

  return (
    <>
      <Table<RdsSummary>
        variant="borderless"
        loading={loading}
        items={items}
        trackBy="dbInstanceIdentifier"
        columnDefinitions={[
          {
            id: 'status',
            header: 'Status',
            width: 120,
            cell: (item) => <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.status}</StatusIndicator>,
          },
          { id: 'id', header: 'DB Instance', cell: (item) => <Box variant="samp">{item.dbInstanceIdentifier}</Box> },
          { id: 'engine', header: 'Engine', cell: (item) => item.engine },
          {
            id: 'storage',
            header: 'Free storage',
            cell: (item) => `${item.freeStorageGb.toFixed(1)} / ${item.allocatedStorageGb.toFixed(0)} GiB`,
          },
          { id: 'region', header: 'Region', cell: (item) => item.region },
          {
            id: 'actions',
            header: '',
            cell: (item) => {
              const lifecycleActions = rdsLifecycleActionsForStatus(item.status);
              return (
                <ButtonDropdown
                  items={[
                    { id: 'RDS_IncreaseStorage', text: 'Increase storage' },
                    { id: 'RDS_ApplyResourceGovernance', text: 'Apply resource governance' },
                    {
                      id: 'operator-group',
                      text: 'Operator actions (lifecycle)',
                      items: [
                        { id: 'RDS_Start', text: 'Start', disabled: !isOperator || !lifecycleActions.canStart },
                        { id: 'RDS_Stop', text: 'Stop', disabled: !isOperator || !lifecycleActions.canStop },
                        { id: 'RDS_Reboot', text: 'Reboot', disabled: !isOperator || !lifecycleActions.canReboot },
                      ],
                    },
                  ]}
                  onItemClick={({ detail }) => handleAction(item, detail.id)}
                  variant="normal"
                >
                  Actions
                </ButtonDropdown>
              );
            },
          },
        ]}
        empty={<Box textAlign="center">No RDS instances.</Box>}
      />
      <ConfirmationDialog {...generalDialog.dialogProps} />
      <ConfirmationDialog {...lifecycleDialog.dialogProps} />
    </>
  );
}

function AlbTable({ items, loading }: { items: AlbSummary[]; loading: boolean }) {
  return (
    <Table<AlbSummary>
      variant="borderless"
      loading={loading}
      items={items}
      trackBy="name"
      columnDefinitions={[
        {
          id: 'status',
          header: 'Status',
          width: 120,
          cell: (item) => <StatusIndicator type={statusIndicatorType(item.threshold.level)}>{item.state}</StatusIndicator>,
        },
        { id: 'name', header: 'Load balancer', cell: (item) => item.name },
        {
          id: 'targets',
          header: 'Healthy targets',
          cell: (item) => `${item.totalTargets - item.unhealthyTargets} / ${item.totalTargets}`,
        },
        { id: 'region', header: 'Region', cell: (item) => item.region },
      ]}
      empty={<Box textAlign="center">No load balancers.</Box>}
    />
  );
}
