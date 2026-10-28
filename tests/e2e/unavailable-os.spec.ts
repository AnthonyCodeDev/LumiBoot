import { expect, test } from '@playwright/test';

/**
 * The "Windows 7" catalog card, the group mother, opens the mother page; its
 * default Professional variant boots straight from the local RAW disk of the
 * codebase: no media import and no "Required media" card. When that private
 * disk is not published, as in CI, the runtime check must nevertheless block the
 * launch and explain the missing manifest.
 */
test.describe('Windows 7: local disk missing', () => {
  test('blocks the launch without asking for a user import', async ({ page }) => {
    // The private disk may exist on a development machine, but it is not
    // published in CI. The tested absence case is therefore forced instead of
    // depending on the local content of `images/`.
    await page.route(/\/images\/windows-7-(?:pro-sp1-)?x86\/manifest\.json(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/');
    await page.getByLabel('Search for a system').fill('windows');
    // The first card is now the neutral mother "Windows 7".
    await page.locator('.os-card').first().click();

    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
    const launchButton = page.getByRole('button', { name: 'Start session' });
    await expect(launchButton).toBeVisible();
    await expect(launchButton).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /manifest.*missing.*404/i }),
    ).toBeVisible();
    // The disk is provided by the operator: no user import card.
    await expect(page.getByText('Required media (provided by you)')).toHaveCount(0);
    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
  });
});
