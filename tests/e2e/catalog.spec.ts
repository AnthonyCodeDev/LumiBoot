import { expect, test } from '@playwright/test';

test.describe('Library', () => {
  test('shows the eight displayed catalog systems (mothers + standalone)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    // 11 entries in the flat catalog, but the 3 child variants (2 Debian +
    // 1 Windows 7 Professional) are folded onto their mother card:
    // 8 displayed cards.
    await expect(page.locator('.os-card')).toHaveCount(8);
  });

  test('searches for a system and filters by family', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    // "debian" matches the console, the Desktop AND the XFCE variant, but the
    // grid only shows the mother card: a single card.
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="debian-12-i386"]')).toHaveCount(1);
    // The search matches child variants, but they are not displayed as
    // standalone cards.
    await expect(page.locator('.os-card[data-id="debian-12-i386-desktop"]')).toHaveCount(0);
    await expect(page.locator('.os-card[data-id="debian-12-i386-xfce"]')).toHaveCount(0);

    await page.getByLabel('Search for a system').fill('');
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(3);
  });

  test('a click opens the page directly (no popup)', async ({ page }) => {
    await page.goto('/');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the Enter key on a card navigates to the page', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.os-card').first();
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

/**
 * Windows 10 x86 is a standalone system, with no more variant group; it is
 * validated and therefore `ready` like Windows 7. Availability relies on the
 * same real boot pipeline as Windows 7, as proven in
 * `tests/e2e/windows10-desktop.spec.ts`.
 */
test.describe('Windows 10 x86 (standalone system)', () => {
  test('exposes a single `ready` card and opens the page', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('windows');

    const card = page.locator('.os-card[data-id="windows-10-x86"]');
    await expect(card).toHaveCount(1);
    // No phantom card anymore: the x64 variant does not exist.
    await expect(page.locator('.os-card[data-id="windows-10-x64"]')).toHaveCount(0);
    // Validated through the same pipeline as Windows 7: advertised as `ready`,
    // hence "Available".
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'ready');

    await card.click();
    await expect(page).toHaveURL(/\/systems\/windows-10-x86$/);
  });
});
