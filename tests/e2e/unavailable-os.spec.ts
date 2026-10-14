import { expect, test } from '@playwright/test';

/**
 * Honnêteté de l'interface : un système en préparation ne doit jamais laisser
 * créer une session en erreur. Le bouton « Lancer une session » est désactivé
 * et la raison est affichée explicitement.
 */
test.describe('Système non disponible', () => {
  test('désactive le lancement avec une raison explicite', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('windows');
    await page.locator('.os-card').first().click();

    const launchButton = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launchButton).toBeVisible();
    await expect(launchButton).toBeDisabled();
    // Le libellé « En préparation » apparaît aussi sur les cartes : on cible
    // la raison explicite du tiroir (rôle `status`, texte unique).
    await expect(page.getByRole('dialog').getByRole('status')).toContainText(/en préparation/i);

    await expect(page).not.toHaveURL(/\/session\//);
  });
});
