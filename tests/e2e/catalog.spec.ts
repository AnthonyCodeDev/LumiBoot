import { expect, test } from '@playwright/test';

test.describe('Bibliothèque', () => {
  test('affiche les neuf systèmes du catalogue', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bibliothèque' })).toBeVisible();
    await expect(page.locator('.os-card')).toHaveCount(9);
  });

  test('recherche un système et filtre par famille', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    await expect(page.locator('.os-card')).toHaveCount(1);

    await page.getByLabel('Rechercher un système').fill('');
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(3);
  });

  test('le clic ouvre directement la fiche (sans popup)', async ({ page }) => {
    await page.goto('/');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('la touche Entrée sur une carte navigue vers la fiche', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.os-card').first();
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
