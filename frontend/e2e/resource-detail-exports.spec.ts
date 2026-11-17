import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';
import { EC2_RUNNING, RDS_AVAILABLE, ACTION_AUDIT_RECORDS } from './fixtures/data';

/**
 * Resource Detail page (`/resource/$resourceType/$resourceId`) action dropdown, plus the
 * Compliance and Cost pages' Export CSV buttons (same `useExportCsv` hook already verified for
 * Infra in `infra.spec.ts` — checked again here for the other 2 exportable tabs to close out
 * `ExportableTab = 'infra' | 'compliance' | 'cost'`).
 */

test.describe('Resource Detail page', () => {
  test('EC2 resource: shows metrics, action history, and the actions dropdown', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto(`/resource/ec2/${EC2_RUNNING.instanceId}`);

    await expect(page.getByRole('heading', { name: EC2_RUNNING.name, level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CPUUtilization', level: 3 })).toBeVisible();

    // Action history table, populated from GET /actions/audit.
    await expect(page.getByRole('heading', { name: 'Action history' })).toBeVisible();
    await expect(page.getByText(ACTION_AUDIT_RECORDS[0].actionType)).toBeVisible();
    await expect(page.getByText(ACTION_AUDIT_RECORDS[0].executedBy)).toBeVisible();

    // Actions dropdown: running instance -> "Stop" + "Rightsize" + Reboot (enabled, operator).
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Rightsize (downsize one step)' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Reboot' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:EC2_Reboot')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('RDS resource: actions dropdown reflects lifecycle eligibility for an available instance', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto(`/resource/rds/${RDS_AVAILABLE.dbInstanceIdentifier}`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Increase storage' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Start' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeEnabled();
  });

  test('an unknown resource id shows the "no real-time data" warning instead of throwing', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/resource/ec2/i-doesnotexist');
    await expect(page.getByText('No real-time data for this resource')).toBeVisible();
  });
});

test.describe('Export CSV on Compliance and Cost pages', () => {
  test('Compliance page Export CSV triggers a download', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/compliance');
    await expect(page.getByRole('heading', { name: 'Backup & Compliance', level: 1 })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^compliance-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('Cost page Export CSV triggers a download', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page);
    await page.goto('/cost');
    await expect(page.getByRole('heading', { name: 'Cost', level: 1 })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^cost-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
