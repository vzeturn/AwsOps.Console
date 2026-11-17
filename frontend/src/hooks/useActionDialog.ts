import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ActionExecutionRequest, ActionExecutionResult, ActionType } from '@ops-dashboard/shared';
import { useActionPreviewDirect } from './useApi';
import type { ConfirmationDialogProps } from '../components/ConfirmationDialog';

type ExecuteBody = Omit<ActionExecutionRequest, 'executedBy' | 'correlationId'>;
type ExecuteMutation = UseMutationResult<ActionExecutionResult, Error, ExecuteBody>;

/**
 * Wires the "direct" preview flow (`GET /actions/preview?actionType=...&resourceId=...`, used by
 * every action NOT reached from an Assessment recommendation) to a Confirmation_Dialog, so every
 * page that adds a 1-click action repeats the same 4 lines instead of re-deriving the preview ->
 * confirm -> execute -> refresh state machine each time.
 *
 * Takes the CALLER's execute mutation (one of `useActionExecute`/`useActionLifecycle`/
 * `useActionEc2Management`/`useSecurityGroupAction`) rather than owning one itself, because which
 * endpoint an action must go through is fixed by `ACTION_CATALOG`'s operator-gating families
 * (shared/src/index.ts) — this hook stays endpoint-agnostic.
 */
export function useActionDialog(execute: ExecuteMutation) {
  const [pending, setPending] = useState<
    | {
        actionType: ActionType;
        resourceId: string;
        region: string;
        params: Record<string, string>;
        title: string;
        extraDetails?: { label: string; value: string }[];
      }
    | undefined
  >();

  const preview = useActionPreviewDirect();

  function open(args: {
    actionType: ActionType;
    resourceId: string;
    region?: string;
    params?: Record<string, string>;
    title: string;
    extraDetails?: { label: string; value: string }[];
  }) {
    const params = args.params ?? {};
    setPending({ actionType: args.actionType, resourceId: args.resourceId, region: args.region ?? '', params, title: args.title, extraDetails: args.extraDetails });
    execute.reset();
    preview.mutate({ actionType: args.actionType, resourceId: args.resourceId, params });
  }

  function close() {
    setPending(undefined);
    preview.reset();
    execute.reset();
  }

  function confirm() {
    if (!pending) return;
    execute.mutate({
      actionType: pending.actionType,
      resourceId: pending.resourceId,
      region: pending.region,
      params: pending.params,
    });
  }

  const dialogProps: ConfirmationDialogProps = {
    visible: Boolean(pending),
    onDismiss: close,
    title: pending?.title ?? '',
    preview: preview.data,
    previewLoading: preview.isPending,
    previewError: preview.isError ? (preview.error as Error).message : undefined,
    executing: execute.isPending,
    executeError: execute.isError ? (execute.error as Error).message : undefined,
    result: execute.data,
    onConfirm: confirm,
    extraDetails: pending?.extraDetails,
  };

  return { open, close, dialogProps };
}
