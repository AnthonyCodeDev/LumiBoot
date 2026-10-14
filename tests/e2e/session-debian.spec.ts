import { expect, test } from '@playwright/test';

test.describe('Session Debian (honnête, non intégrée)', () => {
  test('ne simule jamais un démarrage et affiche un message explicite', async ({ page }) => {
    await page.goto('/');
    await page.locator('.os-card').first().click();
    await page.getByRole('button', { name: 'Préparer le lancement' }).click();

    await expect(page).toHaveURL(/\/session\//);
    await expect(page.getByRole('heading', { name: /Aucune machine/i })).toBeVisible();
    await expect(page.getByText(/n'est pas encore intégré|n’est pas encore intégré/)).toBeVisible();
  });
});
