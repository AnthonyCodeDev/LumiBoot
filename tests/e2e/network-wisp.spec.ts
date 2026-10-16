import { expect, test, type Locator } from '@playwright/test';

/**
 * Réseau invité réel via un **relais WISP** personnel (mode `user-relay`).
 *
 * Ce test est **opt-in** : il n'est jamais exécuté, ni présenté comme réussi,
 * sans un vrai relais WISP compatible v86 fourni par l'utilisateur. L'adresse
 * du relais n'est **jamais** codée en dur (ni dans les sources, ni en CI) : elle
 * provient uniquement de la variable d'environnement `LUMIBOOT_WISP_RELAY_URL`.
 *
 * Activation :
 *
 *   $env:LUMIBOOT_WISP_RELAY_URL='wss://relay.example.org/wisp'
 *   $env:VM_E2E_ASSETS='1'
 *   pnpm test:e2e --grep "WISP"
 *
 * Sans ces deux variables, tous les cas sont **ignorés** (skipped).
 *
 * Le profil `user-relay` est injecté par **interception de requête Playwright**
 * (`page.route` sur `lumiboot.config.json`), comme le fait déjà
 * `network-debian.spec.ts` pour le relais injoignable. Le fichier public
 * `apps/web/public/lumiboot.config.json` n'est **jamais** modifié : aucune
 * exécution parallèle ni interruption ne peut laisser le dépôt altéré.
 */
const relay = process.env.LUMIBOOT_WISP_RELAY_URL;
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Identique au helper de `network-debian.spec.ts` (sortie isolée par marqueurs). */
async function probe(
  serial: Locator,
  command: string,
  id: string,
  timeoutMs: number,
): Promise<string> {
  const begin = `__${id}_B__`;
  const end = `__${id}_E__`;
  await serial.click();

  await serial.pressSequentially(`echo ${begin}\n`, { delay: 40 });
  await expect(serial).toHaveValue(new RegExp(`\\n${begin}\\r?\\n`), { timeout: 20_000 });

  await serial.pressSequentially(`${command}; echo ${end}\n`, { delay: 40 });
  await expect(serial).toHaveValue(new RegExp(`\\n${end}\\r?\\n`), { timeout: timeoutMs });

  const value = (await serial.inputValue()) ?? '';
  const endLine = value.lastIndexOf(`\n${end}`);
  const beginLine = value.lastIndexOf(`\n${begin}`, endLine);
  if (beginLine < 0 || endLine < 0) return value.slice(0, Math.max(0, endLine));
  const start = value.indexOf('\n', beginLine + 1) + 1;
  return value.slice(start, endLine);
}

test.describe('Réseau WISP (user-relay, opt-in)', () => {
  test.skip(
    !relay || !assetsPresent,
    'Relais WISP de test (LUMIBOOT_WISP_RELAY_URL) + artefacts (VM_E2E_ASSETS=1) requis.',
  );

  test('le relais WISP transporte HTTPS et rend apt-get update fonctionnel', async ({ page }) => {
    test.setTimeout(1_200_000);

    // Le relais doit être un vrai relais WISP TLS ; une adresse brute invalide
    // ferait de toute façon échouer la validation du profil.
    const relayUrl = relay ?? '';
    expect(relayUrl).toMatch(/^wss:\/\//);

    // Injection du profil `user-relay` au niveau du réseau Playwright : le
    // fichier public n'est PAS modifié (isolé des autres specs parallèles).
    await page.route('**/lumiboot.config.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          network: { defaultProfile: { mode: 'user-relay', relayUrl }, systems: {} },
          proxy: { enabled: true },
        }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    await page.locator('.os-card').first().click();
    await page.getByRole('button', { name: 'Lancer une session' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(page.locator('.session-console')).toBeVisible();

    await page.getByRole('button', { name: 'Logs' }).click();

    const state = page.locator('.session-toolbar');
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 90_000 });

    // DHCP/DNS via le relais.
    const addr = await probe(serial, 'ip -br addr', 'WISP_ADDR', 30_000);
    expect(addr).toMatch(/enp0s10\s+UP/);
    expect(addr).toMatch(/192\.168\.\d+\.\d+/);

    const dns = await probe(serial, 'getent hosts deb.debian.org', 'WISP_DNS', 30_000);
    expect(dns).toMatch(/\d+\.\d+\.\d+\.\d+/);

    // HTTPS (443) À TRAVERS le relais : un vrai relais WISP transporte le TCP
    // arbitraire, donc curl doit obtenir une réponse HTTP 2xx/3xx.
    const https = await probe(serial, 'curl -I https://deb.debian.org/', 'WISP_HTTPS', 90_000);
    expect(https).toMatch(/HTTP\/1\.[01] [23]\d\d/);

    // `apt-get update` de bout en bout : aucune erreur `Err:`/`E:` ne doit
    // apparaître, et apt doit réellement lister/lire les dépôts.
    const apt = await probe(serial, 'sudo apt-get update', 'WISP_APT', 300_000);
    expect(apt).not.toMatch(/Err:/);
    expect(apt).not.toMatch(/E: /);
    expect(apt).toMatch(/Reading package lists|Hit:|Get:/);
  });
});
