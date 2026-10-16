import { expect, test } from '@playwright/test';

/**
 * Windows 7 démarre directement depuis le disque RAW local de la codebase :
 * aucun import de média, aucune carte « Média requis », aucun blocage. Le
 * bouton « Lancer une session » est actif sans rien demander.
 */
test.describe('Windows 7 : lancement direct sans import', () => {
  test('propose « Lancer une session » sans carte d’import ni média requis', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('windows');
    await page.locator('.os-card').first().click();

    await expect(page).toHaveURL(/\/systems\//);
    const launchButton = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launchButton).toBeVisible();
    await expect(launchButton).toBeEnabled();
    // Plus aucune carte d'import de média Windows.
    await expect(page.getByText('Média requis (fourni par vous)')).toHaveCount(0);
    // On ne clique pas « Lancer » ici : le boot v86 réel est hors périmètre e2e.
    await expect(page).toHaveURL(/\/systems\//);
  });
});
