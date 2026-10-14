import { expect, test } from '@playwright/test';

/**
 * Intégration de la configuration globale et retrait de la page Settings.
 *
 * Ces tests vérifient trois faits observables dans l'application servie :
 *  1. `/settings` n'existe plus : aucune page réseau n'est rendue, l'état
 *     « introuvable » s'affiche à la place.
 *  2. La disponibilité du catalogue reste DÉRIVÉE : Debian (boot réel prouvé)
 *     porte le badge « Disponible ».
 *  3. `public/lumiboot.config.json` est bien déployé et servi en JSON (jamais
 *     le repli SPA HTML), avec la version 1 et un profil réseau par défaut.
 */
test.describe('Configuration globale et retrait de Settings', () => {
  test("n'expose plus de page Settings (état introuvable)", async ({ page }) => {
    await page.goto('/settings');

    // La route inconnue est captée par `path: '*'` : page introuvable visible.
    await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible();

    // Aucun panneau réseau ni libellé de l'ancienne page Settings ne subsiste.
    await expect(page.getByText('Paramètres réseau')).toHaveCount(0);
    await expect(page.locator('.network-panel')).toHaveCount(0);
  });

  test('affiche Debian comme disponible dans la bibliothèque', async ({ page }) => {
    await page.goto('/');

    const debianCard = page.locator('.os-card[data-id="debian-12-i386"]');
    await expect(debianCard).toHaveCount(1);

    const badge = debianCard.locator('.card-status');
    await expect(badge).toHaveAttribute('data-state', 'ready');
    await expect(badge).toHaveText('Disponible');
  });

  test('sert lumiboot.config.json en JSON (version 1 + profil réseau par défaut)', async ({
    page,
  }) => {
    const response = await page.request.get('/lumiboot.config.json');

    expect(response.ok()).toBeTruthy();
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType).toContain('json');

    const text = await response.text();
    // Jamais le repli SPA : le fichier doit contenir du JSON, pas du HTML.
    expect(text.trimStart().startsWith('<')).toBe(false);

    const config = JSON.parse(text) as {
      version: unknown;
      network?: { defaultProfile?: unknown };
    };
    expect(config.version).toBe(1);
    expect(config.network?.defaultProfile).toBeDefined();
  });
});
