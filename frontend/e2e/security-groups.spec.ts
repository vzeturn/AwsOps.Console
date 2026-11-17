import { test, expect } from '@playwright/test';
import { mockSignedInUser } from './fixtures/auth';
import { mockApi } from './fixtures/mockApi';
import { SECURITY_GROUPS_DATA } from './fixtures/data';

/**
 * Security Groups page (`src/routes/security-groups.tsx`) — covers all 7
 * `SECURITY_GROUP_ACTION_TYPES`: Create, Delete, Authorize/Revoke Ingress, Authorize/Revoke Egress.
 * Create/Delete go through the shared `ConfirmationDialog` (via `useActionDialog`); Add/Remove rule
 * use their OWN inline confirmation (the Add Rule modal's own typed-confirmation field for a rule
 * carrying a `securityImpactWarning`) — a genuinely different UI, not a bug, see `submitAddRule` in
 * the route file.
 */

const group = SECURITY_GROUPS_DATA.groups[0];

async function gotoSecurityGroups(page: import('@playwright/test').Page) {
  await mockSignedInUser(page);
  await mockApi(page);
  await page.goto('/security-groups');
  await expect(page.getByRole('heading', { name: 'Security Groups', level: 1 })).toBeVisible();
  // The per-group ExpandableSection is collapsed by default (only the inbound-rules sub-section
  // inside it defaults to expanded) — expand it first so its rule tables are actually in the DOM.
  await page.getByRole('button', { name: new RegExp(`${group.groupName} \\(${group.groupId}\\)`) }).click();
}

test.describe('Security Groups page', () => {
  test('lists groups with their ingress/egress rules', async ({ page }) => {
    await gotoSecurityGroups(page);
    await expect(page.getByText(`${group.groupName} (${group.groupId})`)).toBeVisible();
    // Both the ingress and egress fixture rules use cidrIp 0.0.0.0/0 — scope by the
    // ExpandableSection's accessible name (Cloudscape exposes `headerText` as a labelled group) to
    // avoid a strict-mode ambiguity between the two tables.
    const inboundGroup = page.getByRole('group', { name: /Inbound rules/ });
    await expect(inboundGroup.getByText(group.ingressRules[0].cidrIp)).toBeVisible();
  });

  test('SecurityGroup_Create: create modal -> preview -> confirm (reversible, no typed confirm)', async ({ page }) => {
    await gotoSecurityGroups(page);
    await page.getByRole('button', { name: 'Create security group' }).click();

    const createModal = page.getByRole('dialog', { name: 'Create security group' });
    await expect(createModal).toBeVisible();
    await createModal.getByLabel('Group name').fill('e2e-new-sg');
    await createModal.getByLabel('Description').fill('created by e2e test');
    await createModal.getByLabel('VPC ID').fill('vpc-0e2e0001');
    await createModal.getByRole('button', { name: 'Next' }).click();

    const dialog = page.getByRole('dialog', { name: 'Create security group' });
    await expect(dialog.getByText('mock:SecurityGroup_Create')).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('SecurityGroup_Delete: irreversible -> requires typing the exact group id', async ({ page }) => {
    await gotoSecurityGroups(page);
    // Only one group in the fixture, so the "Delete" button is unambiguous.
    await page.getByRole('button', { name: 'Delete' }).click();

    const dialog = page.getByRole('dialog', { name: /Delete security group/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('mock:SecurityGroup_Delete')).toBeVisible();
    const confirmButton = dialog.getByRole('button', { name: 'Confirm' });
    await expect(confirmButton).toBeDisabled();
    await dialog.getByLabel(new RegExp(`Type "${group.groupId}"`)).fill(group.groupId);
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(dialog.getByText('Outcome: success')).toBeVisible();
  });

  test('Add ingress rule on a sensitive port open to the world requires typed confirmation', async ({ page }) => {
    await gotoSecurityGroups(page);
    // "Add rule" appears twice per group (inbound + outbound). The ExpandableSection's `headerActions`
    // button is a SIBLING of the header ROW containing the "Inbound rules (N)" toggle (two ancestor
    // levels up from the toggle's own <span>), NOT immediately adjacent to it and NOT inside the
    // `group` role that wraps only the section's body/table.
    const inboundToggle = page.getByRole('button', { name: /Inbound rules/ });
    await inboundToggle.locator('..').locator('..').getByRole('button', { name: 'Add rule' }).click();

    const modal = page.getByRole('dialog', { name: /Add ingress rule/ });
    await expect(modal).toBeVisible();
    await modal.getByLabel('From port').fill('22');
    await modal.getByLabel('To port').fill('22');
    await modal.getByLabel('Source CIDR').fill('0.0.0.0/0');

    const addButton = modal.getByRole('button', { name: 'Add rule' });
    await addButton.click();

    // buildSecurityImpactWarning fires for port 22 (SSH) open to 0.0.0.0/0 -> the modal shows the
    // warning inline and requires typing the group id before "Add rule" can be clicked again.
    await expect(modal.getByText('CRITICAL SECURITY WARNING', { exact: false })).toBeVisible();
    await expect(addButton).toBeDisabled();
    await modal.getByLabel('Type the Security Group id to confirm').fill(group.groupId);
    await expect(addButton).toBeEnabled();
    await addButton.click();
    await expect(modal).not.toBeVisible();
  });

  test('Add ingress rule with a non-sensitive port and no warning submits immediately', async ({ page }) => {
    await gotoSecurityGroups(page);
    const inboundToggle = page.getByRole('button', { name: /Inbound rules/ });
    await inboundToggle.locator('..').locator('..').getByRole('button', { name: 'Add rule' }).click();

    const modal = page.getByRole('dialog', { name: /Add ingress rule/ });
    await modal.getByLabel('From port').fill('8080');
    await modal.getByLabel('To port').fill('8080');
    await modal.getByLabel('Source CIDR').fill('10.0.0.0/16');
    await modal.getByRole('button', { name: 'Add rule' }).click();
    await expect(modal).not.toBeVisible();
  });

  test('Remove an existing removable ingress rule', async ({ page }) => {
    await gotoSecurityGroups(page);
    const rule = group.ingressRules[0];
    const row = page.getByRole('row', { name: new RegExp(rule.cidrIp.replace(/\./g, '\\.')) });
    await expect(row).toBeVisible();
    const removeButton = row.getByRole('button', { name: 'Remove' });
    await expect(removeButton).toBeEnabled();
    await removeButton.click();
  });

  test('Remove is disabled for a non-removable egress rule', async ({ page }) => {
    await gotoSecurityGroups(page);
    // Outbound rules section defaults to COLLAPSED (only Inbound has `defaultExpanded`) — expand it first.
    await page.getByRole('button', { name: /Outbound rules/ }).click();
    const outboundGroup = page.getByRole('group', { name: /Outbound rules/ });
    const rule = group.egressRules[0];
    const row = outboundGroup.getByRole('row', { name: new RegExp(rule.cidrIp.replace(/\./g, '\\.')) });
    await expect(row.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});
