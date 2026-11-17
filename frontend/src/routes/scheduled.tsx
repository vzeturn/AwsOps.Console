import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import Input from '@cloudscape-design/components/input';
import DateInput from '@cloudscape-design/components/date-input';
import TimeInput from '@cloudscape-design/components/time-input';
import Tiles from '@cloudscape-design/components/tiles';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { OneTimeSchedule, RecurringRule } from '@ops-dashboard/shared';
import { useInfra, useScheduledActions, useCreateSchedule, useDeleteSchedule } from '../hooks/useApi';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/scheduled')({
  component: ScheduledPage,
});

type TargetKind = 'ec2' | 'rds';

function ScheduledPage() {
  const infra = useInfra();
  const scheduled = useScheduledActions();
  const createSchedule = useCreateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const [targetKind, setTargetKind] = useState<TargetKind>('ec2');
  const [ec2Option, setEc2Option] = useState<SelectProps.Option | null>(null);
  const [ec2TargetType, setEc2TargetType] = useState('');
  const [rdsOption, setRdsOption] = useState<SelectProps.Option | null>(null);
  const [rdsTargetClass, setRdsTargetClass] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  const summary = useMemo(() => {
    const rules = scheduled.data?.recurringRules ?? [];
    return {
      oneTimeCount: scheduled.data?.oneTimeSchedules.length ?? 0,
      recurringCount: rules.length,
      enabledCount: rules.filter((r) => r.state === 'ENABLED').length,
    };
  }, [scheduled.data]);

  const ec2Options: SelectProps.Option[] = (infra.data?.ec2 ?? []).map((i) => ({
    value: i.instanceId,
    label: `${i.name} (${i.instanceId})`,
    description: `Currently ${i.instanceType}`,
  }));
  const rdsOptions: SelectProps.Option[] = (infra.data?.rds ?? []).map((r) => ({
    value: r.dbInstanceIdentifier,
    label: r.dbInstanceIdentifier,
    description: `Currently ${r.engine}`,
  }));

  const canSubmit =
    date.length > 0 &&
    time.length > 0 &&
    (targetKind === 'ec2' ? Boolean(ec2Option) && ec2TargetType.length > 0 : Boolean(rdsOption) && rdsTargetClass.length > 0);

  function submit() {
    if (!canSubmit) return;
    const runAtIso = new Date(`${date}T${time}:00`).toISOString();
    createSchedule.mutate(
      {
        runAtIso,
        ...(targetKind === 'ec2' && ec2Option
          ? { ec2: { instanceId: ec2Option.value ?? '', targetType: ec2TargetType } }
          : {}),
        ...(targetKind === 'rds' && rdsOption
          ? { rds: { instanceIdentifier: rdsOption.value ?? '', targetClass: rdsTargetClass } }
          : {}),
      },
      {
        onSuccess: () => {
          setEc2Option(null);
          setRdsOption(null);
          setEc2TargetType('');
          setRdsTargetClass('');
          setDate('');
          setTime('');
        },
      },
    );
  }

  return (
    <ContentLayout header={<Header variant="h1">Scheduled Runs</Header>}>
      <SpaceBetween size="l">
        {!scheduled.isLoading && scheduled.data && (
          <Container disableContentPaddings>
            <Box padding="l">
              <KpiTileRow>
                <KpiTile label="One-time schedules pending" value={String(summary.oneTimeCount)} />
                <KpiTile label="Recurring rules enabled" value={`${summary.enabledCount} / ${summary.recurringCount}`} />
              </KpiTileRow>
            </Box>
          </Container>
        )}
        <Container header={<Header variant="h2">Schedule a one-time downsize</Header>}>
          <Form
            actions={
              <Button variant="primary" loading={createSchedule.isPending} disabled={!canSubmit} onClick={submit}>
                Schedule
              </Button>
            }
          >
            <SpaceBetween size="m">
              {createSchedule.isError && (
                <Alert type="error" header="Failed to create schedule">
                  {(createSchedule.error as Error).message}
                </Alert>
              )}
              <FormField label="Target type">
                <Tiles
                  value={targetKind}
                  onChange={(event: { detail: { value: string } }) => setTargetKind(event.detail.value as TargetKind)}
                  items={[
                    { value: 'ec2', label: 'EC2 instance' },
                    { value: 'rds', label: 'RDS instance' },
                  ]}
                />
              </FormField>
              {targetKind === 'ec2' ? (
                <>
                  <FormField label="Instance">
                    <Select
                      selectedOption={ec2Option}
                      options={ec2Options}
                      placeholder="Choose an EC2 instance"
                      filteringType="auto"
                      onChange={(event: { detail: SelectProps.ChangeDetail }) => setEc2Option(event.detail.selectedOption)}
                    />
                  </FormField>
                  <FormField label="Target instance type" description="e.g. t3.medium">
                    <Input
                      value={ec2TargetType}
                      onChange={(event: { detail: { value: string } }) => setEc2TargetType(event.detail.value)}
                    />
                  </FormField>
                </>
              ) : (
                <>
                  <FormField label="Instance">
                    <Select
                      selectedOption={rdsOption}
                      options={rdsOptions}
                      placeholder="Choose an RDS instance"
                      filteringType="auto"
                      onChange={(event: { detail: SelectProps.ChangeDetail }) => setRdsOption(event.detail.selectedOption)}
                    />
                  </FormField>
                  <FormField label="Target instance class" description="e.g. db.t3.medium">
                    <Input
                      value={rdsTargetClass}
                      onChange={(event: { detail: { value: string } }) => setRdsTargetClass(event.detail.value)}
                    />
                  </FormField>
                </>
              )}
              <FormField label="Run at (local time)">
                <SpaceBetween direction="horizontal" size="xs">
                  <DateInput
                    value={date}
                    onChange={(event: { detail: { value: string } }) => setDate(event.detail.value)}
                    placeholder="YYYY-MM-DD"
                  />
                  <TimeInput
                    value={time}
                    onChange={(event: { detail: { value: string } }) => setTime(event.detail.value)}
                    format="hh:mm"
                    placeholder="hh:mm"
                  />
                </SpaceBetween>
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>

        {scheduled.isError && (
          <Alert type="error" header="Failed to load scheduled actions">
            {(scheduled.error as Error).message}
          </Alert>
        )}
        {deleteSchedule.isError && (
          <Alert type="error" header="Failed to delete schedule">
            {(deleteSchedule.error as Error).message}
          </Alert>
        )}

        <Table<OneTimeSchedule>
          variant="container"
          loading={scheduled.isLoading}
          items={scheduled.data?.oneTimeSchedules ?? []}
          trackBy="name"
          header={<Header counter={scheduled.data ? `(${scheduled.data.oneTimeSchedules.length})` : undefined}>One-time schedules</Header>}
          columnDefinitions={[
            { id: 'runAt', header: 'Run at', cell: (item) => new Date(item.runAtIso).toLocaleString() },
            {
              id: 'target',
              header: 'Target',
              cell: (item) =>
                item.ec2
                  ? `EC2 ${item.ec2.instanceId} → ${item.ec2.targetType}`
                  : item.rds
                    ? `RDS ${item.rds.instanceIdentifier} → ${item.rds.targetClass}`
                    : '—',
            },
            {
              id: 'actions',
              header: '',
              cell: (item) => (
                <Button
                  variant="inline-link"
                  loading={deleteSchedule.isPending}
                  onClick={() => deleteSchedule.mutate(item.name)}
                >
                  Delete
                </Button>
              ),
            },
          ]}
          empty={<Box textAlign="center">No one-time schedules.</Box>}
        />

        <Table<RecurringRule>
          variant="container"
          loading={scheduled.isLoading}
          items={scheduled.data?.recurringRules ?? []}
          trackBy="name"
          header={<Header counter={scheduled.data ? `(${scheduled.data.recurringRules.length})` : undefined}>Recurring rules</Header>}
          columnDefinitions={[
            {
              id: 'state',
              header: 'State',
              width: 120,
              cell: (item) => <StatusIndicator type={item.state === 'ENABLED' ? 'success' : 'stopped'}>{item.state}</StatusIndicator>,
            },
            { id: 'name', header: 'Name', cell: (item) => item.name },
            { id: 'schedule', header: 'Schedule', cell: (item) => <Box variant="samp">{item.scheduleExpression}</Box> },
            { id: 'description', header: 'Description', cell: (item) => item.description ?? '—' },
          ]}
          empty={<Box textAlign="center">No recurring rules.</Box>}
        />
      </SpaceBetween>
    </ContentLayout>
  );
}
