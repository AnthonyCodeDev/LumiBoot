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

    // Les logs série sont masqués par défaut : on les affiche pour pouvoir
    // lire/taper dans `.v86-serial` pendant le reste du test.
    await page.getByRole('button', { name: 'Logs' }).click();

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

    // Autologin VGA (tty1) : l'utilisateur ne doit jamais taper son login.
    // La console VGA en mode texte (vgacon, pas de framebuffer bochs-drm)
    // doit afficher un shell connecté `lumiboot@lumiboot` avec la bannière
    // `automatic login`, et ne doit PAS rester bloquée sur une invite
    // `login:` en attente de saisie (timeout généreux : l'émulation
    // logicielle met ~1-2 min à stabiliser l'écran texte).
    // Note : la bannière d'autologin elle-même contient la chaîne
    // `login:`, donc on vérifie l'absence d'invite *en attente* (écran se
    // terminant par `login:`) plutôt qu'une absence naïve de la sous-chaîne.
    const vga = page.locator('.v86-screen-text');
    await expect(vga).toContainText(/lumiboot@lumiboot/, { timeout: 180_000 });
    const vgaText = (await vga.textContent()) ?? '';
    expect(vgaText).toContain('lumiboot@lumiboot');
    expect(vgaText).toContain('automatic login');
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // sudo NOPASSWD pour lumiboot depuis la console série.
    await serial.pressSequentially('sudo -n whoami\n', { delay: 25 });
    await expect(serial).toHaveValue(/root/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Arrêter' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Redémarrer' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });
  });
});
