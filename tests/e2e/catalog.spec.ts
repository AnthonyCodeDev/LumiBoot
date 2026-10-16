import { expect, test } from '@playwright/test';

test.describe('Bibliothèque', () => {
  test('affiche les huit systèmes affichés du catalogue (mères + autonomes)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bibliothèque' })).toBeVisible();
    // 10 entrées au catalogue plat, mais les 2 variantes Debian enfants sont
    // repliées sur la carte de leur mère : 8 cartes affichées.
    await expect(page.locator('.os-card')).toHaveCount(8);
  });

  test('recherche un système et filtre par famille', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    // « debian » matche la console, la variante Bureau ET XFCE, mais la grille
    // ne montre que la carte de la mère : une seule carte.
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="debian-12-i386"]')).toHaveCount(1);
    // La recherche matche les variantes enfants, mais elles ne s'affichent pas
    // comme cartes autonomes.
    await expect(page.locator('.os-card[data-id="debian-12-i386-desktop"]')).toHaveCount(0);
    await expect(page.locator('.os-card[data-id="debian-12-i386-xfce"]')).toHaveCount(0);

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
