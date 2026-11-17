import Modal from '@cloudscape-design/components/modal';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
import Button from '@cloudscape-design/components/button';
import type { RunbookEntry } from '@ops-dashboard/shared';

/**
 * The ONE modal used to display a runbook (symptom/diagnosis/remediation/rollback/escalation) —
 * mirrors `ConfirmationDialog`'s "one shared component, not N ad-hoc copies" convention. Uses
 * `Modal` (not a Cloudscape `Drawer`) specifically so it looks and behaves consistently with
 * `ConfirmationDialog`, the other modal already used everywhere in this app, rather than
 * introducing a second, differently-styled UI surface for operational guidance.
 *
 * Purely a display component — it has no data-fetching of its own, the caller looks up the
 * `RunbookEntry` (via `getRunbookForFinding`/`getRunbookForMetric`) and passes it in, same
 * division of responsibility `ConfirmationDialog` already uses for `ActionPreview`.
 */
export interface RunbookModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Short context shown under the runbook's own title, e.g. the specific resource name this
   * runbook currently applies to — the same catalog entry can be opened for many different
   * resources, this makes it clear which one triggered it. */
  context?: string;
  entry: RunbookEntry | undefined;
}

const SEVERITY_ALERT_TYPE: Record<RunbookEntry['defaultSeverity'], 'info' | 'warning' | 'error'> = {
  info: 'info',
  warning: 'warning',
  critical: 'error',
};

function StepList({ steps }: { steps: string[] }) {
  return (
    <Box>
      <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
        {steps.map((step, index) => (
          <li key={index} style={{ marginBottom: index < steps.length - 1 ? '6px' : 0 }}>
            {step}
          </li>
        ))}
      </ol>
    </Box>
  );
}

export function RunbookModal({ visible, onDismiss, context, entry }: RunbookModalProps) {
  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={entry ? entry.title : 'Runbook'}
      size="large"
      footer={
        <Box float="right">
          <Button variant="link" onClick={onDismiss}>
            Close
          </Button>
        </Box>
      }
    >
      {!entry ? (
        <Alert type="info" header="No runbook available yet">
          This finding/metric does not have a dedicated runbook entry yet — use the general
          troubleshooting process for its resource type, or check the AWS Console directly.
        </Alert>
      ) : (
        <SpaceBetween size="l">
          <SpaceBetween size="xs">
            {context && (
              <Box color="text-body-secondary" fontSize="body-s">
                {context}
              </Box>
            )}
            <Badge color={entry.defaultSeverity === 'critical' ? 'red' : entry.defaultSeverity === 'warning' ? 'blue' : 'grey'}>
              {entry.defaultSeverity}
            </Badge>
            <Box>{entry.symptom}</Box>
          </SpaceBetween>

          <Box>
            <Box variant="h4">Diagnosis — confirm before acting</Box>
            <StepList steps={entry.diagnosis} />
          </Box>

          <Box>
            <Box variant="h4">Remediation</Box>
            <StepList steps={entry.remediation} />
          </Box>

          {entry.rollback && entry.rollback.length > 0 && (
            <Box>
              <Box variant="h4">Rollback</Box>
              <StepList steps={entry.rollback} />
            </Box>
          )}

          <Alert type={SEVERITY_ALERT_TYPE[entry.defaultSeverity]} header="Escalate instead of acting alone when">
            <StepList steps={entry.escalateWhen} />
          </Alert>
        </SpaceBetween>
      )}
    </Modal>
  );
}
