import { expect, test } from '@playwright/test';

test.describe('Bibliothèque', () => {
  test('affiche les huit systèmes du catalogue', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Bibliothèque' })).toBeVisible();
    await expect(page.locator('.os-card')).toHaveCount(8);
    await expect(page.locator('.count')).toHaveText('08');
  });

  test('recherche un système et filtre par famille', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    await expect(page.locator('.os-card')).toHaveCount(1);

    await page.getByLabel('Rechercher un système').fill('');
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(3);
  });

  test('ouvre et ferme la fiche système au clavier', async ({ page }) => {
    await page.goto('/');
    await page.locator('.os-card').first().click();
    const drawer = page.locator('.detail-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('persiste un favori après rechargement', async ({ page }) => {
    await page.goto('/');
    const firstCard = page.locator('.os-card').first();
    await firstCard.getByRole('button', { name: /favoris/ }).click();
    await expect(firstCard.getByRole('button', { name: /favoris/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.reload();
    await expect(
      page
        .locator('.os-card')
        .first()
        .getByRole('button', { name: /favoris/ }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
