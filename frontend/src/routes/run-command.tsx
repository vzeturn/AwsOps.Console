import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Spinner from '@cloudscape-design/components/spinner';
import { SSM_RUN_PRESETS, SSM_RUN_COMMAND_POLL_TIMEOUT_MS } from '@ops-dashboard/shared';
import { useInfra, useRunCommandAction, useRunCommandStatus } from '../hooks/useApi';
import { statusIndicatorType } from '../lib/thresholdStatus';

export const Route = createFileRoute('/run-command')({
  component: RunCommandPage,
});

const PRESET_OPTIONS: SelectProps.Option[] = SSM_RUN_PRESETS.map((preset) => ({
  value: preset.id,
  label: preset.label,
  description: preset.description,
}));

function RunCommandPage() {
  const infra = useInfra();
  const run = useRunCommandAction();
  const [instanceOption, setInstanceOption] = useState<SelectProps.Option | null>(null);
  const [presetOption, setPresetOption] = useState<SelectProps.Option | null>(PRESET_OPTIONS[0] ?? null);
  const [commandId, setCommandId] = useState<string | undefined>();
  const [startedAt, setStartedAt] = useState<number | undefined>();

  const instanceOptions: SelectProps.Option[] = (infra.data?.ec2 ?? []).map((instance) => ({
    value: instance.instanceId,
    label: `${instance.name} (${instance.instanceId})`,
    description: `${instance.region} · ${instance.platform} · ${instance.state}`,
  }));

  const selectedInstance = infra.data?.ec2.find((i) => i.instanceId === instanceOption?.value);

  const status = useRunCommandStatus(commandId);
  const timedOut = Boolean(startedAt) && Date.now() - (startedAt ?? 0) > SSM_RUN_COMMAND_POLL_TIMEOUT_MS && !status.data?.isTerminal;

  function submit() {
    if (!instanceOption || !presetOption || !selectedInstance) return;
    setCommandId(undefined);
    run.mutate(
      {
        actionType: 'SSM_RunPreset',
        resourceId: selectedInstance.instanceId,
        region: selectedInstance.region,
        params: { presetId: presetOption.value ?? '' },
      },
      {
        onSuccess: (result) => {
          if (result.commandId) {
            setCommandId(result.commandId);
            setStartedAt(Date.now());
          }
        },
      },
    );
  }

  return (
    <ContentLayout header={<Header variant="h1">Run Command</Header>}>
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">Send a diagnostic command</Header>}>
          <Form
            actions={
              <Button variant="primary" loading={run.isPending} disabled={!instanceOption || !presetOption} onClick={submit}>
                Run
              </Button>
            }
          >
            <SpaceBetween size="m">
              <FormField label="Instance" description="Only EC2 instances known to the Infrastructure tab are selectable.">
                <SpaceBetween size="xs">
                  <Select
                    selectedOption={instanceOption}
                    options={instanceOptions}
                    placeholder="Choose an instance"
                    filteringType="auto"
                    loadingText="Loading instances…"
                    statusType={infra.isLoading ? 'loading' : 'finished'}
                    onChange={(event: { detail: SelectProps.ChangeDetail }) => setInstanceOption(event.detail.selectedOption)}
                  />
                  {selectedInstance && (
                    <StatusIndicator type={statusIndicatorType(selectedInstance.threshold.level)}>
                      {selectedInstance.state}
                    </StatusIndicator>
                  )}
                </SpaceBetween>
              </FormField>
              <FormField label="Preset" description="5 read-only presets. No free-form command input is ever accepted.">
                <Select
                  selectedOption={presetOption}
                  options={PRESET_OPTIONS}
                  onChange={(event: { detail: SelectProps.ChangeDetail }) => setPresetOption(event.detail.selectedOption)}
                />
              </FormField>
            </SpaceBetween>
          </Form>
        </Container>

        {run.isError && (
          <Alert type="error" header="Failed to send command">
            {(run.error as Error).message}
          </Alert>
        )}

        {commandId && (
          <Container
            header={
              <Header
                variant="h2"
                description={<Box variant="samp">{commandId}</Box>}
                actions={
                  status.data && (
                    <StatusIndicator
                      type={status.data.status === 'Success' ? 'success' : status.data.isTerminal ? 'error' : 'in-progress'}
                    >
                      {status.data.status}
                    </StatusIndicator>
                  )
                }
              >
                Result
              </Header>
            }
          >
            <SpaceBetween size="m">
              {!status.data?.isTerminal && !timedOut && (
                <Box>
                  <Spinner /> Waiting for the instance to run the command…
                </Box>
              )}
              {timedOut && !status.data?.isTerminal && (
                <Alert type="warning" header="Still running">
                  No terminal result within {SSM_RUN_COMMAND_POLL_TIMEOUT_MS / 1000}s of polling — the command may
                  still complete on the instance; check the SSM console for the final result.
                </Alert>
              )}
              {status.data && (
                <SpaceBetween size="s">
                  <Box color="text-body-secondary" fontSize="body-s">
                    {status.data.statusDetails}
                  </Box>
                  {status.data.isTerminal && (
                    <>
                      <Box variant="h4">stdout</Box>
                      <Container disableContentPaddings>
                        <Box variant="pre" fontSize="body-s" padding="s">
                          {status.data.stdout || '(empty)'}
                        </Box>
                      </Container>
                      {status.data.stderr && (
                        <>
                          <Box variant="h4">stderr</Box>
                          <Container disableContentPaddings>
                            <Box variant="pre" fontSize="body-s" color="text-status-error" padding="s">
                              {status.data.stderr}
                            </Box>
                          </Container>
                        </>
                      )}
                      {status.data.truncated && (
                        <Alert type="info">Output was truncated — the full output exceeds the display limit.</Alert>
                      )}
                    </>
                  )}
                </SpaceBetween>
              )}
            </SpaceBetween>
          </Container>
        )}
      </SpaceBetween>
    </ContentLayout>
  );
}
