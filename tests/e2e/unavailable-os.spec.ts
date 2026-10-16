import { expect, test } from '@playwright/test';

/**
 * La carte catalogue « Windows 7 » (mère du groupe) ouvre la fiche de la mère ;
 * sa variante par défaut (Professionnel) démarre directement depuis le disque
 * RAW local de la codebase : aucun import de média ni carte « Média requis ».
 * Quand ce disque privé n'est pas publié (cas de la CI), le contrôle runtime
 * doit toutefois bloquer le lancement et expliquer l'absence du manifeste.
 */
test.describe('Windows 7 : disque local absent', () => {
  test('bloque le lancement sans demander d’import utilisateur', async ({ page }) => {
    // Le disque privé peut exister sur une machine de développement, mais il
    // n'est pas publié en CI. On force donc le cas d'absence testé au lieu de
    // faire dépendre le résultat du contenu local de `images/`.
    await page.route(/\/images\/windows-7-(?:pro-sp1-)?x86\/manifest\.json(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('windows');
    // La 1re carte est désormais la mère neutre « Windows 7 ».
    await page.locator('.os-card').first().click();

    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
    const launchButton = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launchButton).toBeVisible();
    await expect(launchButton).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /manifeste.*absent.*404/i }),
    ).toBeVisible();
    // Le disque est fourni par l'opérateur : aucune carte d'import utilisateur.
    await expect(page.getByText('Média requis (fourni par vous)')).toHaveCount(0);
    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
  });
});
