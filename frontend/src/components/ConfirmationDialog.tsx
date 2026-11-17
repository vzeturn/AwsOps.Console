import { useEffect, useState } from 'react';
import Modal from '@cloudscape-design/components/modal';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import Badge from '@cloudscape-design/components/badge';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import type { ActionExecutionResult, ActionPreview } from '@ops-dashboard/shared';

/**
 * The ONE Confirmation_Dialog used by every action-execution flow in the app (Assessment
 * recommendations, Infra table row actions, Resource Detail actions, Security Group management).
 * One component instead of N ad-hoc modals so the safety mechanics — irreversible/security
 * type-to-confirm, cost/security warnings, live preview refresh — can never drift between pages
 * the way N independent copies inevitably would.
 *
 * Contract with the caller: the parent owns `open`, fetches the `ActionPreview` (via
 * `useActionPreview`/`useActionPreviewDirect`) and passes it in along with an `onConfirm` that
 * performs the real execution mutation. This component only renders what the preview says and
 * gates the confirm button — it has no AWS knowledge of its own.
 */
export interface ConfirmationDialogProps {
  visible: boolean;
  onDismiss: () => void;
  title: string;
  preview: ActionPreview | undefined;
  previewLoading: boolean;
  previewError: string | undefined;
  executing: boolean;
  executeError: string | undefined;
  result: ActionExecutionResult | undefined;
  onConfirm: () => void;
  /** Extra fields the caller wants shown above the generic preview.params dump (e.g. "New
   * instance type: t3.large" rendered from a live Select value, before the preview call even
   * returns params echoing it back). Optional. */
  extraDetails?: { label: string; value: string }[];
}

/** `awsApiCall` values containing these substrings correspond to `ACTION_CATALOG` entries whose
 * doc comments (shared/src/index.ts) confirm the action is a one-way AWS operation — kept here
 * only as a DISPLAY hint for the icon; the actual gate is `preview.reversibilityClass`, which the
 * backend computes from the same catalog and is what this component trusts. */
function outcomeAlertType(outcome: ActionExecutionResult['outcome']): 'success' | 'warning' | 'error' {
  if (outcome === 'success') return 'success';
  if (outcome === 'partial') return 'warning';
  return 'error';
}

export function ConfirmationDialog({
  visible,
  onDismiss,
  title,
  preview,
  previewLoading,
  previewError,
  executing,
  executeError,
  result,
  onConfirm,
  extraDetails,
}: ConfirmationDialogProps) {
  const [confirmText, setConfirmText] = useState('');

  // Reset the type-to-confirm field every time a fresh dialog opens (a new resource, a new
  // preview) — carrying over a previous confirmation string across dialogs would let a user
  // accidentally confirm action B just because they'd already typed the id for action A.
  useEffect(() => {
    if (visible) setConfirmText('');
  }, [visible, preview?.resource.id]);

  const requiresTypedConfirmation = Boolean(preview) && (preview!.reversibilityClass === 'irreversible' || Boolean(preview!.securityImpactWarning));
  const confirmDisabled =
    !preview || previewLoading || executing || (requiresTypedConfirmation && confirmText !== preview.resource.id);

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={title}
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss} disabled={executing}>
              {result ? 'Close' : 'Cancel'}
            </Button>
            {!result && (
              <Button variant="primary" loading={executing} disabled={confirmDisabled} onClick={onConfirm}>
                Confirm
              </Button>
            )}
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        {previewLoading && (
          <Box textAlign="center" padding="l">
            <Spinner /> Loading live preview…
          </Box>
        )}
        {previewError && (
          <Alert type="error" header="Could not build a preview for this action">
            {previewError}
          </Alert>
        )}

        {preview && !result && (
          <>
            <KeyValuePairs
              columns={1}
              items={[
                { label: 'AWS API call', value: <Box variant="samp">{preview.awsApiCall}</Box> },
                { label: 'Resource', value: <Box variant="samp">{preview.resource.id}</Box> },
                { label: 'Region', value: preview.resource.region },
                {
                  label: 'Reversibility',
                  value: (
                    <Badge color={preview.reversibilityClass === 'irreversible' ? 'red' : 'green'}>
                      {preview.reversibilityClass}
                    </Badge>
                  ),
                },
              ]}
            />

            {extraDetails && extraDetails.length > 0 && (
              <KeyValuePairs columns={1} items={extraDetails.map((d) => ({ label: d.label, value: d.value }))} />
            )}

            {Object.keys(preview.params).length > 0 && (
              <KeyValuePairs
                columns={1}
                items={Object.entries(preview.params).map(([key, value]) => ({
                  label: key,
                  value: <Box variant="samp">{String(value)}</Box>,
                }))}
              />
            )}

            {/* Security warning renders ABOVE the cost warning, in a danger tone — see the
                ActionPreview.securityImpactWarning doc comment in shared/src/index.ts for why the
                ordering/tone must not be diluted by the generic cost warning. */}
            {preview.securityImpactWarning && (
              <Alert type="error" header="Security impact">
                {preview.securityImpactWarning}
              </Alert>
            )}
            {preview.costImpactWarning && (
              <Alert type="warning" header="Cost impact">
                {preview.costImpactWarning}
              </Alert>
            )}
            {preview.reversibilityClass === 'irreversible' && !preview.securityImpactWarning && (
              <Alert type="warning" header="This action cannot be undone">
                Once confirmed, this change is permanent — there is no corresponding action to reverse it.
              </Alert>
            )}

            {requiresTypedConfirmation && (
              <FormField label={`Type "${preview.resource.id}" to confirm`}>
                <Input value={confirmText} onChange={(event: { detail: { value: string } }) => setConfirmText(event.detail.value)} />
              </FormField>
            )}
          </>
        )}

        {executeError && (
          <Alert type="error" header="Execution failed">
            {executeError}
          </Alert>
        )}

        {result && (
          <Alert type={outcomeAlertType(result.outcome)} header={`Outcome: ${result.outcome}`}>
            {result.reason ?? 'The action completed.'}
          </Alert>
        )}
      </SpaceBetween>
    </Modal>
  );
}
