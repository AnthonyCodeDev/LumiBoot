import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Boot RÉEL de Debian 12 i386 « Bureau » (Xorg + Openbox) dans v86.
 *
 * Ce test n'est activé que lorsque l'image desktop est réellement publiée
 * (`rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`) :
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm exec playwright test tests/e2e/desktop-debian.spec.ts
 *
 * Sans cette variable, le test est **ignoré** (pas « réussi ») : aucune image,
 * donc aucune preuve possible.
 *
 * Preuve recherchée : le marqueur `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop`
 * écrit par l'invité sur `ttyS0` **après** que le serveur X réponde (`xdpyinfo`)
 * et qu'Openbox tourne. Aucun marqueur n'est produit côté JavaScript/React.
 */

/** L'émulation logicielle (sans accélération) est lente : budget mural large. */
const BOOT_MARKER_TIMEOUT_MS = 420_000;
/** Délai court après le marqueur : `running` suit le marqueur de très près. */
const RUNNING_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const READY_MARKER = 'LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop';
const FAILED_MARKER = 'LUMIBOOT_DESKTOP_START_FAILED:debian-12-i386-desktop';

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/**
 * Attend la preuve de session graphique et renvoie un statut lisible.
 *
 * On surveille le `<textarea>` `.v86-serial` (la sortie invité vit dans sa
 * *valeur*, pas dans son contenu texte) ET l'état de session. On s'arrête dès
 * qu'un marqueur (READY ou START_FAILED) apparaît, ou que la session passe en
 * `error`. Aucun de ces signaux n'est simulé : ils proviennent tous de v86 ou
 * de l'invité. Si rien n'arrive dans le délai, on renvoie `timeout` et le test
 * échoue en imprimant la sortie série complète pour diagnostic.
 */
async function waitForDesktopProof(page: Page): Promise<'ready' | 'failed' | 'error' | 'timeout'> {
  try {
    const handle = await page.waitForFunction(
      ([ready, failed]) => {
        const serial = document.querySelector<HTMLTextAreaElement>('textarea.v86-serial');
        const value = serial?.value ?? '';
        if (value.includes(ready)) return 'ready';
        if (value.includes(failed)) return 'failed';
        if (document.querySelector('.session-toolbar')?.getAttribute('data-state') === 'error') {
          return 'error';
        }
        return null;
      },
      [READY_MARKER, FAILED_MARKER] as const,
      { timeout: BOOT_MARKER_TIMEOUT_MS, polling: 1_000 },
    );
    return (await handle.jsonValue()) as 'ready' | 'failed' | 'error';
  } catch {
    return 'timeout';
  }
}

async function openDesktopSession(page: Page): Promise<{ serial: Locator; state: Locator }> {
  await page.goto('/');
  await page.getByLabel('Rechercher un système').fill('debian');
  // La carte Debian ouvre la MÈRE ; XFCE est présélectionné, on bascule sur la
  // variante Bureau (X11) via le dropdown custom SANS changement d'URL, puis on
  // lance.
  await page.locator('.os-card[data-id="debian-12-i386"]').click();
  await expect(page).toHaveURL(/\/systems\/debian-12-i386$/);
  await page.getByRole('button', { name: 'Choisir la variante' }).click();
  await page.getByRole('button', { name: 'Debian X11', exact: true }).click();
  // Le dropdown ne navigue pas : on reste sur la fiche de la mère.
  await expect(page).toHaveURL(/\/systems\/debian-12-i386$/);
  await page.getByRole('button', { name: 'Lancer une session' }).click();
  await expect(page).toHaveURL(/\/session\//);

  // Le conteneur de console reste monté pendant tout le démarrage.
  await expect(page.locator('.session-console')).toBeVisible();
  // Les logs série sont masqués par défaut : on les affiche pour lire `.v86-serial`.
  await page.getByRole('button', { name: 'Logs' }).click();

  return { serial: page.locator('.v86-serial'), state: page.locator('.session-toolbar') };
}

/** Dump la sortie série complète dans la sortie de test (diagnostic). */
async function dumpSerial(page: Page, serial: Locator, reason: string): Promise<string> {
  const value = (await serial.inputValue().catch(() => '')) || '';
  console.log(`\n=== SORTIE SÉRIE COMPLÈTE (${reason}) ===\n${value}\n=== FIN SORTIE SÉRIE ===\n`);
  await test.info().attach(`serial-${reason}`, { body: value, contentType: 'text/plain' });
  return value;
}

test.describe('Session Debian 12 i386 Bureau (Xorg + Openbox, boot réel)', () => {
  test.skip(!assetsPresent, 'Image desktop absente : définir VM_E2E_ASSETS=1.');

  test('démarre une vraie session graphique, la rend au navigateur et redémarre', async ({
    page,
  }) => {
    // Deux boots graphiques complets sous émulation logicielle lente : budget
    // mural explicite et large (marqueur jusqu'à 420 s par boot).
    test.setTimeout(1_200_000);

    const { serial, state } = await openDesktopSession(page);

    // 1. Preuve de session graphique (marqueur invité sur ttyS0, jamais simulé).
    const proof = await waitForDesktopProof(page);
    if (proof !== 'ready') {
      const value = await dumpSerial(page, serial, proof);
      // Un marqueur d'échec explicite est signalé tel quel ; sinon la sortie
      // série complète est jointe pour diagnostiquer (X, vesa, dbus, startx…).
      expect(
        proof,
        `Session graphique non prouvée (statut=${proof}). ` +
          `Marqueur attendu : ${READY_MARKER}.\nSortie série :\n${value}`,
      ).toBe('ready');
    }

    // 2. `running` n'est émis qu'APRÈS `DESKTOP_READY` (voir V86Instance).
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });

    // 3. Rendu graphique réel : le canvas VGA est affiché (mode graphique) et
    //    dimensionné. En mode texte, v86 masque le canvas (`display:none`).
    const screen = page.locator('.v86-screen');
    const canvas = page.locator('.v86-screen-canvas');
    await expect(screen).toBeVisible();
    await expect(canvas).toBeVisible({ timeout: DEFAULT_PROBE_TIMEOUT_MS });
    const dims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    expect(dims.width).toBeGreaterThan(0);
    expect(dims.height).toBeGreaterThan(0);

    // 4. Inspection visuelle : écran complet + écran VGA seul.
    await page.screenshot({ path: 'test-results/desktop-boot.png' });
    await page.locator('.session-console').screenshot({ path: 'test-results/desktop-vga.png' });

    // 5. Aucun `login:` bloquant : la console VGA de tty1 a été remplacée par la
    //    session graphique (canvas en mode graphique). On vérifie qu'aucune
    //    invite de connexion *en attente* n'est visible. On ne tape AUCUNE
    //    commande dans la GUI (fiabilité incertaine sous émulation logicielle).
    const vgaText = (await page.locator('.v86-screen-text').textContent()) ?? '';
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // 6. Arrêt puis redémarrage : cycle de vie complet, aucune ressource orpheline.
    await page.getByRole('button', { name: 'Arrêter' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });

    await page.getByRole('button', { name: 'Redémarrer' }).click();
    await expect(page).toHaveURL(/\/session\//);

    const restarted = await openRestartProof(page);
    if (restarted !== 'ready') {
      const value = await dumpSerial(page, page.locator('.v86-serial'), `restart-${restarted}`);
      expect(
        restarted,
        `Session graphique non prouvée après redémarrage (statut=${restarted}).\nSortie série :\n${value}`,
      ).toBe('ready');
    }
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });
  });
});

/**
 * Le Redémarrer recrée une session neuve : les locators restent valides (mêmes
 * classes) mais la sortie série repart de zéro. On réaffiche les logs et on
 * attend de nouveau la preuve graphique.
 */
async function openRestartProof(page: Page): Promise<'ready' | 'failed' | 'error' | 'timeout'> {
  await expect(page.locator('.session-console')).toBeVisible();
  const logsButton = page.getByRole('button', { name: 'Logs' });
  if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
    await logsButton.click();
  }
  return waitForDesktopProof(page);
}
