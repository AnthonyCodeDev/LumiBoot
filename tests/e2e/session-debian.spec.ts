import { expect, test } from '@playwright/test';

/**
 * Boot réel de Debian 12 i386 dans v86.
 *
 * Ce test n'est activé que lorsque les artefacts Debian sont réellement publiés
 * (rootfs.img, vmlinuz-686, initrd.img, manifest.json) et que l'image est
 * marquée disponible. Il ne remplace JAMAIS un test mocké par une preuve de
 * fonctionnement : sans artefacts, il est explicitement ignoré, pas « réussi ».
 *
 *   VM_E2E_ASSETS=1 pnpm test:e2e
 */
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

test.describe('Session Debian 12 i386 (v86, boot réel)', () => {
  test.skip(!assetsPresent, 'Artefacts Debian absents : définir VM_E2E_ASSETS=1.');

  test('démarre un vrai Debian, exécute des commandes invitées et redémarre', async ({ page }) => {
    // Deux boots complets d'un Debian systemd sous émulation logicielle :
    // ~60-90 s par boot en temps mural. Budget explicite, pas de triche.
    test.setTimeout(600_000);
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    await page.locator('.os-card').first().click();
    await page.getByRole('button', { name: 'Lancer une session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    // Le conteneur de console reste monté pendant tout le démarrage.
    await expect(page.locator('.session-console')).toBeVisible();

    const state = page.locator('.session-state');
    // `running` = marqueur émis par le Debian invité sur ttyS0, pas un timer.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    // La sortie série vit dans la *valeur* du textarea (pas son contenu
    // texte) : `toContainText` reste vide même quand l'invité parle.
    // On attend l'invite de login avant de taper (le shell met quelques
    // secondes à apparaître après le marqueur de readiness).
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 60_000 });
    await serial.click();
    for (const command of ['uname -a', 'cat /etc/os-release', 'echo LumiBootOK']) {
      await serial.pressSequentially(`${command}\n`, { delay: 25 });
    }
    // Preuves produites par l'invité, jamais par React.
    await expect(serial).toHaveValue(/Debian GNU\/Linux 12 \(bookworm\)/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LumiBootOK/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Arrêter' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Redémarrer' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });
  });
});
