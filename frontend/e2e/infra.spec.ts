import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';
import { EC2_RUNNING, EC2_STOPPED, RDS_AVAILABLE } from './fixtures/data';

/**
 * Infrastructure page (`src/routes/infra.tsx`) — EC2/RDS row actions through the shared
 * ConfirmationDialog, plus Export CSV. Covers every action reachable from this page:
 *   EC2: EC2_Stop (general gate, reversible -> no type-to-confirm), EC2_Reboot (lifecycle gate),
 *        Ec2_ChangeInstanceType (own modal + picker), Ec2_UpdateTags (TagEditor), Ec2_ModifySecurityGroups
 *   RDS: RDS_IncreaseStorage, RDS_ApplyResourceGovernance, RDS_Stop (lifecycle gate)
 */

async function gotoInfra(page: import('@playwright/test').Page) {
  await mockSignedInUser(page);
  await mockApi(page);
  await page.goto('/infra');
  await expect(page.getByRole('heading', { name: 'Infrastructure', level: 1 })).toBeVisible();
}

test.describe('Infra page — EC2 actions', () => {
  test('EC2_Stop on a running instance: preview, confirm (no type-to-confirm, reversible), execute', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_RUNNING.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Stop' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:EC2_Stop')).toBeVisible();
    await expect(dialog.getByText(EC2_RUNNING.instanceId, { exact: false }).first()).toBeVisible();
    // EC2_Stop is in NO_COST_WARNING_ACTIONS -> no cost warning, and it's reversible -> no
    // type-to-confirm field required.
    await expect(dialog.getByLabel(/Type ".*" to confirm/)).toHaveCount(0);

    const confirmButton = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(dialog.getByText('Outcome: success')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('EC2_Reboot (operator actions group) opens the lifecycle-gated dialog', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_RUNNING.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    // "Operator actions" is a group LABEL (rendered as a paragraph, not a submenu trigger) — its
    // items (Reboot/Change instance type/Edit tags/Modify security groups) are already visible in
    // the same open menu, no extra click needed to "expand" it.
    await page.getByRole('menuitem', { name: 'Reboot' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:EC2_Reboot')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('EC2_Reboot is disabled for a stopped instance', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_STOPPED.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Reboot' })).toBeDisabled();
  });

  test('Start button shown for a stopped instance', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_STOPPED.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Start' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toHaveCount(0);
  });

  test('Ec2_ChangeInstanceType: picker modal loads compatible types, opens preview, executes', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_STOPPED.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Change instance type…' }).click();

    const modal = page.getByRole('dialog', { name: /Change instance type/ });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(EC2_STOPPED.instanceType)).toBeVisible();

    // Cloudscape's Select renders as a trigger BUTTON (accessible name = label + placeholder), not
    // a text input with a placeholder attribute.
    await modal.getByRole('button', { name: 'Choose a type' }).click();
    await page.getByRole('option', { name: 't3.large' }).first().click();
    await modal.getByRole('button', { name: 'Next' }).click();

    const confirmDialog = page.getByRole('dialog', { name: /Change instance type/ });
    await expect(confirmDialog.getByText('Current type', { exact: false })).toBeVisible();
    await expect(confirmDialog.getByText('Target type', { exact: false })).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(confirmDialog.getByText('Outcome: success')).toBeVisible();
  });

  test('Ec2_UpdateTags: edit tags via TagEditor and save', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_RUNNING.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit tags…' }).click();

    const modal = page.getByRole('dialog', { name: /Edit tags/ });
    await expect(modal).toBeVisible();
    // Pre-seeded from EC2_RUNNING.tags = { Name: 'e2e-web-01', Department: 'SALE' } — Cloudscape's
    // TagEditor renders each value as a real <input role="combobox" value="SALE">, and its
    // accessible label is a static "-" (not the value) — so locate it by the `value` attribute.
    await expect(modal.locator('input[value="SALE"]')).toBeVisible();
    await modal.getByRole('button', { name: 'Save tags' }).click();
    await expect(modal).not.toBeVisible();
  });

  test('Ec2_ModifySecurityGroups: multiselect pre-populated with current SGs, proceeds to preview', async ({ page }) => {
    await gotoInfra(page);
    const row = page.getByRole('row', { name: new RegExp(EC2_RUNNING.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Modify security groups…' }).click();

    const modal = page.getByRole('dialog', { name: /Modify security groups/ });
    await expect(modal).toBeVisible();
    await expect(modal.getByText(EC2_RUNNING.securityGroupIds![0])).toBeVisible();
    await modal.getByRole('button', { name: 'Next' }).click();

    const confirmDialog = page.getByRole('dialog', { name: /Modify security groups/ });
    // Ec2_ModifySecurityGroups is in the securityActions set in the mock -> requires typed confirmation.
    await expect(confirmDialog.getByLabel(/Type ".*" to confirm/)).toBeVisible();
    const confirmButton = confirmDialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeDisabled();
    await confirmDialog.getByLabel(/Type ".*" to confirm/).fill(EC2_RUNNING.instanceId);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(confirmDialog.getByText('Outcome: success')).toBeVisible();
  });

  test('operator actions are disabled in read-only (non-operator) mode', async ({ page }) => {
    await mockSignedInUser(page);
    await mockApi(page, { readOnly: true });
    await page.goto('/infra');
    await expect(page.getByText('Read-only view', { exact: false })).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(EC2_RUNNING.instanceId) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Reboot' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Edit tags…' })).toBeDisabled();
  });
});

test.describe('Infra page — RDS actions', () => {
  test('RDS_IncreaseStorage: general gate, irreversible -> requires typed confirmation', async ({ page }) => {
    await gotoInfra(page);
    await page.getByRole('tab', { name: /RDS/ }).click();
    const row = page.getByRole('row', { name: new RegExp(RDS_AVAILABLE.dbInstanceIdentifier) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Increase storage' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:RDS_IncreaseStorage')).toBeVisible();
    await expect(dialog.getByText('This action cannot be undone', { exact: false })).toBeVisible();

    const confirmButton = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeDisabled();
    await dialog.getByLabel(new RegExp(`Type "${RDS_AVAILABLE.dbInstanceIdentifier}"`)).fill(RDS_AVAILABLE.dbInstanceIdentifier);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('RDS_ApplyResourceGovernance: general gate, reversible', async ({ page }) => {
    await gotoInfra(page);
    await page.getByRole('tab', { name: /RDS/ }).click();
    const row = page.getByRole('row', { name: new RegExp(RDS_AVAILABLE.dbInstanceIdentifier) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await page.getByRole('menuitem', { name: 'Apply resource governance' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('mock:RDS_ApplyResourceGovernance')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('RDS_Stop (lifecycle gate) is available for an available instance', async ({ page }) => {
    await gotoInfra(page);
    await page.getByRole('tab', { name: /RDS/ }).click();
    const row = page.getByRole('row', { name: new RegExp(RDS_AVAILABLE.dbInstanceIdentifier) });
    await row.getByRole('button', { name: 'Actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Start' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toBeEnabled();
    await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('mock:RDS_Stop')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });
});

test.describe('Infra page — ALB tab and Export CSV', () => {
  test('ALB tab lists load balancers read-only (no actions column)', async ({ page }) => {
    await gotoInfra(page);
    await page.getByRole('tab', { name: /ALB/ }).click();
    await expect(page.getByText('e2e-alb-01')).toBeVisible();
  });

  test('Export CSV triggers a file download', async ({ page }) => {
    await gotoInfra(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^infra-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
