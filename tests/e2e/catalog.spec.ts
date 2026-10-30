import { expect, test } from '@playwright/test';

test.describe('Library', () => {
  test('shows the ten displayed catalog systems (mothers + standalone)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    // Child variants fold onto their mother card: 10 mother/standalone cards.
    await expect(page.locator('.os-card')).toHaveCount(10);
  });

  test('searches for a system and filters by family', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    // "debian" matches console/Desktop/XFCE, but only the mother card is shown.
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="debian-12-i386"]')).toHaveCount(1);
    // Child variants are never displayed as standalone cards.
    await expect(page.locator('.os-card[data-id="debian-12-i386-desktop"]')).toHaveCount(0);
    await expect(page.locator('.os-card[data-id="debian-12-i386-xfce"]')).toHaveCount(0);

    await page.getByLabel('Search for a system').fill('');
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(4);

    // The generic entry has its own family chip, after macOS.
    await page.getByRole('button', { name: 'Custom' }).click();
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="custom-image"]')).toHaveCount(1);
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

// Windows 11 is "Not ready"; the generic "Custom image" needs user media.
test.describe('Windows 11 and the generic custom image', () => {
  test('Windows 11 is "Not ready", without an import card', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('.os-card[data-id="windows-11-x64"]');
    await expect(card).toHaveCount(1);
    // `planned` renders as "Not ready": no media is expected from the visitor.
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'planned');
    await expect(card.locator('.card-status')).toHaveText('Not ready');
    // Pending systems stay greyed out, under the separator.
    await expect(card).toHaveClass(/is-muted/);
    await expect(page.locator('.cards-separator')).toHaveCount(1);

    await card.click();
    await expect(page).toHaveURL(/\/systems\/windows-11-x64$/);
    await expect(page.getByText('Required media (provided by you)')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
  });

  test('the custom image is "Resource required" and exposes the import card', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('.os-card[data-id="custom-image"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'resource-required');
    await expect(card.locator('.card-status')).toHaveText('Resource required');
    // Playable: first group, full opacity, not greyed out.
    await expect(card).not.toHaveClass(/is-muted/);
    await expect(card).toHaveCSS('opacity', '1');
    // Its group holds no pending card, and the separator comes after it.
    const playableGroup = page.locator('.cards').first();
    await expect(playableGroup.locator('.os-card[data-id="custom-image"]')).toHaveCount(1);
    await expect(playableGroup.locator('.is-muted')).toHaveCount(0);

    await card.click();
    await expect(page).toHaveURL(/\/systems\/custom-image$/);
    // The visitor imports their own media: the launch stays blocked until then.
    await expect(page.getByText('Required media (provided by you)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
  });
});

// Windows 10 x86 is standalone and validated: `ready` like Windows 7.
test.describe('Windows 10 x86 (standalone system)', () => {
  test('exposes a single `ready` card and opens the page', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('windows');

    const card = page.locator('.os-card[data-id="windows-10-x86"]');
    await expect(card).toHaveCount(1);
    // No phantom card anymore: the x64 variant does not exist.
    await expect(page.locator('.os-card[data-id="windows-10-x64"]')).toHaveCount(0);
    // Validated through the Windows 7 pipeline: advertised as "Available".
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'ready');

    await card.click();
    await expect(page).toHaveURL(/\/systems\/windows-10-x86$/);
  });
});
