import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Container from '@cloudscape-design/components/container';
import Box from '@cloudscape-design/components/box';
import Badge from '@cloudscape-design/components/badge';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Alert from '@cloudscape-design/components/alert';
import Select from '@cloudscape-design/components/select';
import type { SelectProps } from '@cloudscape-design/components/select';
import Modal from '@cloudscape-design/components/modal';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Textarea from '@cloudscape-design/components/textarea';
import type { ApprovalRequest, ApprovalStatus } from '@ops-dashboard/shared';
import { ACTION_CATALOG, isApprovalRequiredActionType, isApprovalStillValid } from '@ops-dashboard/shared';
import { useApprovals, useRequestApproval, useDecideApproval, useExecuteApproval, useMe } from '../hooks/useApi';
import { KpiTile, KpiTileRow } from '../components/KpiTile';

export const Route = createFileRoute('/approvals')({
  component: ApprovalsPage,
});

const STATUS_BADGE_COLOR: Record<ApprovalStatus, 'blue' | 'green' | 'red' | 'grey' | 'severity-medium'> = {
  pending: 'blue',
  approved: 'green',
  rejected: 'red',
  executed: 'grey',
  expired: 'severity-medium',
};

/** Counts by status across whatever the current filter returned — a quick "how many need my
 * attention right now" summary above the table, same KpiTileRow convention every other page uses. */
function useApprovalsSummary(items: ApprovalRequest[]) {
  return useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const item of items) {
      if (item.status === 'pending') pending += 1;
      else if (item.status === 'approved') approved += 1;
      else if (item.status === 'rejected') rejected += 1;
    }
    return { pending, approved, rejected, total: items.length };
  }, [items]);
}

const STATUS_FILTER_OPTIONS: SelectProps.Option[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'executed', label: 'Executed' },
  { value: 'expired', label: 'Expired' },
];

interface RequestFormState {
  actionType: SelectProps.Option;
  resourceId: string;
  requestedReason: string;
}

interface DecideState {
  approval: ApprovalRequest;
  decision: 'approved' | 'rejected';
  decisionReason: string;
}

/** Every actionType requiring approval, per `isApprovalRequiredActionType` (irreversible OR
 * operator-only) — recomputed from `ACTION_CATALOG` rather than hardcoded so a newly added
 * irreversible/operator-only action automatically appears here without a frontend change. */
function useApprovalRequiredActionOptions(): SelectProps.Option[] {
  return useMemo(() => {
    return ACTION_CATALOG.filter((entry) => isApprovalRequiredActionType(entry.actionType)).map((entry) => ({
      value: entry.actionType,
      label: entry.actionType,
    }));
  }, []);
}

function ApprovalsPage() {
  const [statusFilter, setStatusFilter] = useState<SelectProps.Option>(STATUS_FILTER_OPTIONS[1]); // default: Pending
  const approvals = useApprovals((statusFilter.value || undefined) as ApprovalStatus | undefined);
  const requestApproval = useRequestApproval();
  const decideApproval = useDecideApproval();
  const executeApproval = useExecuteApproval();
  const me = useMe();

  const actionTypeOptions = useApprovalRequiredActionOptions();
  const [requestForm, setRequestForm] = useState<RequestFormState | null>(null);
  const [decideState, setDecideState] = useState<DecideState | null>(null);

  const items = approvals.data ?? [];
  const summary = useApprovalsSummary(items);
  const isOperator = me.data?.isOperator ?? false;

  function openRequestForm() {
    setRequestForm({ actionType: actionTypeOptions[0], resourceId: '', requestedReason: '' });
    requestApproval.reset();
  }

  function submitRequest() {
    if (!requestForm || !requestForm.actionType.value || !requestForm.resourceId.trim() || !requestForm.requestedReason.trim()) return;
    requestApproval.mutate(
      {
        actionType: requestForm.actionType.value,
        resourceId: requestForm.resourceId.trim(),
        requestedReason: requestForm.requestedReason.trim(),
      },
      { onSuccess: () => setRequestForm(null) },
    );
  }

  function openDecide(approval: ApprovalRequest, decision: 'approved' | 'rejected') {
    setDecideState({ approval, decision, decisionReason: '' });
    decideApproval.reset();
  }

  function submitDecide() {
    if (!decideState) return;
    if (decideState.decision === 'rejected' && decideState.decisionReason.trim().length === 0) return;
    decideApproval.mutate(
      {
        id: decideState.approval.id,
        decision: decideState.decision,
        ...(decideState.decisionReason.trim() ? { decisionReason: decideState.decisionReason.trim() } : {}),
      },
      { onSuccess: () => setDecideState(null) },
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="Maker-checker approval queue for irreversible/operator-only actions — a different person must decide before an approved request can execute."
          actions={
            <Button variant="primary" onClick={openRequestForm}>
              Request approval
            </Button>
          }
        >
          Approvals
        </Header>
      }
    >
      <SpaceBetween size="l">
        {approvals.isError && (
          <Alert type="error" header="Failed to load approvals">
            {(approvals.error as Error).message}
          </Alert>
        )}
        {decideApproval.isError && (
          <Alert type="error" header="Failed to record decision">
            {(decideApproval.error as Error).message}
          </Alert>
        )}
        {executeApproval.isError && (
          <Alert type="error" header="Execution failed">
            {(executeApproval.error as Error).message}
          </Alert>
        )}

        <Container disableContentPaddings>
          <Box padding="l">
            <KpiTileRow>
              <KpiTile label="Pending" value={String(summary.pending)} severity={summary.pending > 0 ? 'warning' : 'ok'} />
              <KpiTile label="Approved (awaiting execute)" value={String(summary.approved)} />
              <KpiTile label="Rejected" value={String(summary.rejected)} />
              <KpiTile label="Total shown" value={String(summary.total)} />
            </KpiTileRow>
          </Box>
        </Container>

        <Table<ApprovalRequest>
          variant="container"
          loading={approvals.isLoading}
          items={items}
          trackBy="id"
          filter={
            <Select
              selectedOption={statusFilter}
              options={STATUS_FILTER_OPTIONS}
              onChange={(event: { detail: SelectProps.ChangeDetail }) =>
                setStatusFilter(event.detail.selectedOption)
              }
            />
          }
          header={<Header counter={`(${items.length})`}>Approval requests</Header>}
          columnDefinitions={[
            {
              id: 'status',
              header: 'Status',
              width: 110,
              cell: (item) => <Badge color={STATUS_BADGE_COLOR[item.status]}>{item.status}</Badge>,
            },
            { id: 'actionType', header: 'Action', cell: (item) => <Box variant="samp">{item.actionType}</Box> },
            { id: 'resourceId', header: 'Resource', cell: (item) => <Box variant="samp">{item.resourceId}</Box> },
            { id: 'requestedBy', header: 'Requested by', cell: (item) => item.requestedBy },
            { id: 'requestedReason', header: 'Reason', cell: (item) => item.requestedReason },
            {
              id: 'requestedAt',
              header: 'Requested at',
              cell: (item) => new Date(item.requestedAt).toLocaleString(),
            },
            {
              id: 'decidedBy',
              header: 'Decided by',
              cell: (item) => item.decidedBy ?? '—',
            },
            {
              id: 'actions',
              header: '',
              cell: (item) => {
                if (item.status === 'pending') {
                  if (!isOperator) {
                    return (
                      <Box color="text-body-secondary" fontSize="body-s">
                        Awaiting an operator
                      </Box>
                    );
                  }
                  return (
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button variant="inline-link" onClick={() => openDecide(item, 'approved')}>
                        Approve
                      </Button>
                      <Button variant="inline-link" onClick={() => openDecide(item, 'rejected')}>
                        Reject
                      </Button>
                    </SpaceBetween>
                  );
                }
                if (item.status === 'approved') {
                  const stillValid = isApprovalStillValid(item);
                  return (
                    <Button
                      variant="inline-link"
                      disabled={!stillValid || executeApproval.isPending}
                      onClick={() => executeApproval.mutate(item.id)}
                    >
                      {stillValid ? 'Execute' : 'Expired'}
                    </Button>
                  );
                }
                return (
                  <Box color="text-body-secondary" fontSize="body-s">
                    —
                  </Box>
                );
              },
            },
          ]}
          empty={<Box textAlign="center">No approval requests match this filter.</Box>}
        />
      </SpaceBetween>

      <Modal
        visible={requestForm !== null}
        onDismiss={() => setRequestForm(null)}
        header="Request approval"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setRequestForm(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={requestApproval.isPending}
                disabled={
                  !requestForm?.actionType.value || !requestForm.resourceId.trim() || !requestForm.requestedReason.trim()
                }
                onClick={submitRequest}
              >
                Submit request
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {requestForm && (
          <SpaceBetween size="m">
            {requestApproval.isError && <Alert type="error">{(requestApproval.error as Error).message}</Alert>}
            <FormField label="Action type">
              <Select
                selectedOption={requestForm.actionType}
                options={actionTypeOptions}
                filteringType="auto"
                onChange={(event: { detail: SelectProps.ChangeDetail }) =>
                  setRequestForm({ ...requestForm, actionType: event.detail.selectedOption })
                }
              />
            </FormField>
            <FormField label="Resource id" description="e.g. an instance id, volume id, or allocation id">
              <Input
                value={requestForm.resourceId}
                onChange={(event: { detail: { value: string } }) =>
                  setRequestForm({ ...requestForm, resourceId: event.detail.value })
                }
              />
            </FormField>
            <FormField label="Reason" description="Why is this action needed? The approver reviews this before deciding.">
              <Textarea
                value={requestForm.requestedReason}
                onChange={(event: { detail: { value: string } }) =>
                  setRequestForm({ ...requestForm, requestedReason: event.detail.value })
                }
              />
            </FormField>
          </SpaceBetween>
        )}
      </Modal>

      <Modal
        visible={decideState !== null}
        onDismiss={() => setDecideState(null)}
        header={decideState ? `${decideState.decision === 'approved' ? 'Approve' : 'Reject'} request` : ''}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setDecideState(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={decideApproval.isPending}
                disabled={decideState?.decision === 'rejected' && decideState.decisionReason.trim().length === 0}
                onClick={submitDecide}
              >
                Confirm
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        {decideState && (
          <SpaceBetween size="m">
            {decideApproval.isError && <Alert type="error">{(decideApproval.error as Error).message}</Alert>}
            <Box>
              <Box variant="samp">{decideState.approval.actionType}</Box> on{' '}
              <Box variant="samp">{decideState.approval.resourceId}</Box>
            </Box>
            <Box color="text-body-secondary">Requested by {decideState.approval.requestedBy}: {decideState.approval.requestedReason}</Box>
            <FormField
              label={decideState.decision === 'rejected' ? 'Reason for rejection (required)' : 'Note (optional)'}
            >
              <Textarea
                value={decideState.decisionReason}
                onChange={(event: { detail: { value: string } }) =>
                  setDecideState({ ...decideState, decisionReason: event.detail.value })
                }
              />
            </FormField>
          </SpaceBetween>
        )}
      </Modal>
    </ContentLayout>
  );
}
