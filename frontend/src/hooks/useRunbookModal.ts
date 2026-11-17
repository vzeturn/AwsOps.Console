import { useState } from 'react';
import type { RunbookEntry } from '@ops-dashboard/shared';
import type { RunbookModalProps } from '../components/RunbookModal';

/**
 * Owns the open/closed state + which `RunbookEntry`/context is currently shown — the same thin
 * "state machine behind a shared modal" shape `useActionDialog` uses for `ConfirmationDialog`.
 * Kept resource-lookup-agnostic on purpose: the caller passes the already-resolved `RunbookEntry`
 * (from `getRunbookForFinding`/`getRunbookForMetric`) rather than this hook knowing how to look
 * one up itself, so it works identically for both lookup kinds.
 */
export function useRunbookModal() {
  const [state, setState] = useState<{ entry: RunbookEntry | undefined; context?: string } | undefined>();

  function open(entry: RunbookEntry | undefined, context?: string) {
    setState({ entry, context });
  }

  function close() {
    setState(undefined);
  }

  const modalProps: RunbookModalProps = {
    visible: Boolean(state),
    onDismiss: close,
    entry: state?.entry,
    context: state?.context,
  };

  return { open, close, modalProps };
}
