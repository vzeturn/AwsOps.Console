import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';
import { ASSESSMENT_REPORT } from './fixtures/data';

/**
 * Assessment page (`src/routes/assessment.tsx`) — the Execute button only renders for a finding
 * whose `findingType` has a `FINDING_TYPE_ACTION_OVERRIDES` entry (via `matchActionCatalogForFinding`,
 * see `shared/src/action-catalog.ts`); everything else shows "Manual only" text instead. The fixture
 * (`ASSESSMENT_REPORT` in `fixtures/data.ts`) deliberately includes one of each:
 *   rec-0001 (ebsVolumeUnattached)  -> HAS an override (Snapshot_And_Delete_EBS_Volume) -> Execute button
 *   rec-0002 (rdsMissingMultiAz)    -> NO override                                    -> "Manual only"
 */

async function gotoAssessment(page: import('@playwright/test').Page) {
  await mockSignedInUser(page);
  await mockApi(page);
  await page.goto('/assessment');
  await expect(page.getByRole('heading', { name: 'Assessment', level: 1 })).toBeVisible();
}

test.describe('Assessment page', () => {
  test('Execute button only shown for findings with a matching Action_Catalog entry', async ({ page }) => {
    await gotoAssessment(page);

    const withAction = ASSESSMENT_REPORT.recommendations[0]; // ebsVolumeUnattached
    const withoutAction = ASSESSMENT_REPORT.recommendations[1]; // rdsMissingMultiAz

    const rowWithAction = page.getByRole('row', { name: new RegExp(withAction.resourceName) });
    await expect(rowWithAction.getByRole('button', { name: 'Execute' })).toBeVisible();

    const rowWithoutAction = page.getByRole('row', { name: new RegExp(withoutAction.resourceName) });
    await expect(rowWithoutAction.getByText('Manual only')).toBeVisible();
    await expect(rowWithoutAction.getByRole('button', { name: 'Execute' })).toHaveCount(0);
  });

  test('Execute opens preview, confirms, and optimistically marks the recommendation as executed', async ({ page }) => {
    await gotoAssessment(page);

    const rec = ASSESSMENT_REPORT.recommendations[0];
    const row = page.getByRole('row', { name: new RegExp(rec.resourceName) });
    await row.getByRole('button', { name: 'Execute' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:Snapshot_And_Delete_EBS_Volume')).toBeVisible();
    // Snapshot_And_Delete_EBS_Volume is irreversible per ACTION_CATALOG -> requires typed confirmation.
    const confirmInput = dialog.getByLabel(new RegExp(`Type "${rec.resourceId}"`));
    await expect(confirmInput).toBeVisible();
    const confirmButton = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeDisabled();
    await confirmInput.fill(rec.resourceId);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(dialog.getByText('Outcome: success')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible();

    // Optimistic executed state: button becomes disabled and reads "Executed".
    const executedButton = row.getByRole('button', { name: 'Executed' });
    await expect(executedButton).toBeVisible();
    await expect(executedButton).toBeDisabled();
  });

  test('savings and priority columns render correctly', async ({ page }) => {
    await gotoAssessment(page);
    const rec = ASSESSMENT_REPORT.recommendations[0];
    const row = page.getByRole('row', { name: new RegExp(rec.resourceName) });
    await expect(row.getByText(`$${rec.estimatedMonthlySavingsUsd!.toFixed(2)}`)).toBeVisible();
    await expect(row.getByText(rec.priority)).toBeVisible();

    const recNoSavings = ASSESSMENT_REPORT.recommendations[1];
    const rowNoSavings = page.getByRole('row', { name: new RegExp(recNoSavings.resourceName) });
    await expect(rowNoSavings.getByText('—')).toBeVisible();
  });
});
