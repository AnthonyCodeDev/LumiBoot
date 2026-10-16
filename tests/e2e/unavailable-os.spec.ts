import { expect, test } from '@playwright/test';

/**
 * Honnêteté de l'interface : un système dont le média n'est pas fourni ne doit
 * jamais laisser créer une session en erreur. Le bouton « Lancer une session »
 * est désactivé, la raison est explicite et l'import d'un média légal est
 * proposé.
 */
test.describe('Système nécessitant une ressource', () => {
  test('désactive le lancement et propose l’import d’un média légal', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('windows');
    await page.locator('.os-card').first().click();

    await expect(page).toHaveURL(/\/systems\//);
    const launchButton = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launchButton).toBeVisible();
    await expect(launchButton).toBeDisabled();
    await expect(page.locator('.system-detail-actions').getByRole('status')).toContainText(
      /ressource requise/i,
    );
    // Aucune image n'est distribuée : l'utilisateur doit importer son média.
    await expect(page.getByText('Média requis (fourni par vous)')).toBeVisible();

    await expect(page).not.toHaveURL(/\/session\//);
  });
});
