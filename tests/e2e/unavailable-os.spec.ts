import { expect, test } from '@playwright/test';

// Windows 7 mother page: a missing disk blocks the launch, with no import card.
test.describe('Windows 7: local disk missing', () => {
  test('blocks the launch without asking for a user import', async ({ page }) => {
    // Force the absence: the private disk may exist locally but not in CI.
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
