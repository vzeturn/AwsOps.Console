import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';
import { MONITORING_DATA, LOG_GROUPS_DATA } from './fixtures/data';

/**
 * Monitoring page (`ECS_ScaleOut`) and Logs page (`CloudWatchLogGroup_SetRetention`) — both wired
 * through `useActionDialog` + the shared `ConfirmationDialog`, same pattern as `infra.spec.ts`.
 */

test.describe('Monitoring page', () => {
  test('lists online resources and alarms, ECS_ScaleOut opens preview and executes', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/monitoring');
    await expect(page.getByRole('heading', { name: 'Monitoring', level: 1 })).toBeVisible();

    const ecsResource = MONITORING_DATA.resources.find((r) => r.resourceType === 'ecs')!;
    const row = page.getByRole('row', { name: new RegExp(ecsResource.resourceName) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Scale out' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:ECS_ScaleOut')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();

    // EC2 resource row has no "Scale out" button (only ECS gets one).
    const ec2Resource = MONITORING_DATA.resources.find((r) => r.resourceType === 'ec2')!;
    const ec2Row = page.getByRole('row', { name: new RegExp(ec2Resource.resourceName) });
    await expect(ec2Row.getByRole('button', { name: 'Scale out' })).toHaveCount(0);

    await expect(page.getByRole('heading', { name: 'Active alarms' })).toBeVisible();
    await expect(page.getByText(MONITORING_DATA.alerts[0].alarmName)).toBeVisible();
  });
});

test.describe('Logs page', () => {
  test('sets retention on a log group with no retention policy yet', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: 'Logs', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Manage log group retention' }).click();

    const groupNeverExpire = LOG_GROUPS_DATA.groups.find((g) => g.retentionInDays === null)!;
    const groupWithRetention = LOG_GROUPS_DATA.groups.find((g) => g.retentionInDays !== null)!;

    const rowNoRetention = page.getByRole('row', { name: new RegExp(groupNeverExpire.logGroupName.replace(/\//g, '\\/')) });
    await rowNoRetention.getByRole('button', { name: 'Set retention…' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:CloudWatchLogGroup_SetRetention')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();

    // A group that ALREADY has a retention policy shows no "Set retention…" button at all.
    const rowWithRetention = page.getByRole('row', { name: new RegExp(groupWithRetention.logGroupName.replace(/\//g, '\\/')) });
    await expect(rowWithRetention.getByRole('button', { name: 'Set retention…' })).toHaveCount(0);
  });

  test('queries log events for a chosen group and time range', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/logs');

    // Cloudscape's Select renders as a trigger BUTTON (accessible name = placeholder text), not a
    // text input with a placeholder attribute — see infra.spec.ts's Ec2_ChangeInstanceType test.
    await page.getByRole('button', { name: 'Choose a log group' }).click();
    await page.getByRole('option', { name: new RegExp(LOG_GROUPS_DATA.groups[0].logGroupName.replace(/\//g, '\\/')) }).click();
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByText('START RequestId: e2e-test')).toBeVisible();
    await expect(page.getByText('END RequestId: e2e-test')).toBeVisible();
  });
});
