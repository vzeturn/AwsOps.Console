import { useState } from 'react';
import { useActionPreview, useActionExecute } from './useApi';
import type { ConfirmationDialogProps } from '../components/ConfirmationDialog';

/**
 * The Assessment-page counterpart of `useActionDialog` (which wires the "direct" preview variant
 * for resource-table actions). This one wires the RECOMMENDATION-driven preview
 * (`GET /actions/preview?recommendationId=...`) to the same shared `ConfirmationDialog`.
 *
 * Every `RecommendationFindingType` with a `FINDING_TYPE_ACTION_OVERRIDES` entry (shared/src/
 * action-catalog.ts) resolves to a general-gate `ActionType` — none of the 10 recommendation-driven
 * actions belong to the lifecycle/security-group/ec2-management operator-only families — so this
 * hook always executes via `POST /actions/execute`, with no client-side operator-routing logic
 * needed (unlike a hypothetical hook that had to pick between multiple execute endpoints).
 */
export function useRecommendationActionDialog() {
  const [recommendationId, setRecommendationId] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [lastExecutedId, setLastExecutedId] = useState<string | undefined>();

  const preview = useActionPreview(recommendationId);
  const execute = useActionExecute();

  function open(id: string, label: string) {
    setRecommendationId(id);
    setTitle(label);
    execute.reset();
  }

  function close() {
    setRecommendationId(undefined);
  }

  function confirm() {
    if (!preview.data || !recommendationId) return;
    const idToMark = recommendationId;
    execute.mutate(
      {
        actionType: preview.data.actionType,
        resourceId: preview.data.resource.id,
        region: preview.data.resource.region,
        params: preview.data.params,
      },
      { onSuccess: (result) => { if (result.outcome === 'success') setLastExecutedId(idToMark); } },
    );
  }

  const dialogProps: ConfirmationDialogProps = {
    visible: Boolean(recommendationId),
    onDismiss: close,
    title,
    preview: preview.data,
    previewLoading: preview.isPending,
    previewError: preview.isError ? (preview.error as Error).message : undefined,
    executing: execute.isPending,
    executeError: execute.isError ? (execute.error as Error).message : undefined,
    result: execute.data,
    onConfirm: confirm,
  };

  return { open, close, dialogProps, lastExecutedId };
}
