import { expect, test, type Locator } from '@playwright/test';

/**
 * Réseau invité **réel** de Debian 12 i386 (v86), mode `browser-fetch`.
 *
 * Ce fichier n'est activé que lorsque l'image Debian est réellement publiée
 * (`rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`) :
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm test:e2e
 *
 * Sans cette variable, les tests sont **ignorés** (pas « réussis ») : aucune
 * image, donc aucune preuve possible.
 *
 * Ce que ces tests documentent, volontairement, ce sont les **limites
 * effectives** de `v86@0.5.471` et non un « Internet complet » :
 *
 *  - le backend `fetch` de v86 n'enregistre le TCP que pour le **port 80** :
 *    HTTP peut aboutir, **HTTPS (443) échoue** ;
 *  - toute requête reste **soumise à CORS** : un hôte sans en-tête
 *    `Access-Control-Allow-Origin` est refusé par le navigateur, donc
 *    `apt-get update` échoue.
 *
 * Aucun proxy CORS, aucune désactivation de la sécurité navigateur n'est
 * utilisée : ces échecs sont le comportement **attendu** en `browser-fetch`.
 */
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/**
 * Exécute une commande sur la console série et renvoie sa sortie.
 *
 * La console série de v86 recopie dans la *valeur* du `<textarea>` tout ce que
 * l'invité émet, **y compris l'écho du tty**. Un marqueur placé sur la même
 * ligne que la commande peut donc être coupé par un retour à la ligne du tty
 * (terminal 80 colonnes) et n'apparaître qu'une fois. On encadre donc la
 * commande par **deux lignes de marqueurs dédiées et courtes** :
 *
 *     echo <begin>
 *     <command>; echo <end>
 *
 * Chaque marqueur imprimé occupe sa **propre ligne** (`\n<marker>\n`), ce qui
 * le distingue de l'écho de la ligne tapée (`… echo <marker>`) et permet de
 * délimiter la sortie sans ambiguïté. Les deux étapes sont tapées séparément :
 * envoyer les lignes d'un seul bloc sature le tty émulé et désordonne l'écho.
 */
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

/** Parcours commun : bibliothèque -> Debian -> session -> logs -> invite. */
async function bootDebianAndWaitForPrompt(
  page: import('@playwright/test').Page,
  runningTimeout = 180_000,
): Promise<Locator> {
  await page.goto('/');
  await page.getByLabel('Rechercher un système').fill('debian');
  await page.locator('.os-card').first().click();
  await expect(page).toHaveURL(/\/systems\//);
  await page.getByRole('button', { name: 'Lancer une session' }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.locator('.session-console')).toBeVisible();

  await page.getByRole('button', { name: 'Logs' }).click();

  const state = page.locator('.session-toolbar');
  // `running` n'est émis que sur preuve du marqueur invité sur ttyS0.
  await expect(state).toHaveAttribute('data-state', 'running', { timeout: runningTimeout });

  const serial = page.locator('.v86-serial');
  await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 90_000 });
  return serial;
}

test.describe('Réseau invité Debian (browser-fetch, boot réel)', () => {
  test.skip(!assetsPresent, 'Artefacts Debian absents : définir VM_E2E_ASSETS=1.');

  // Deux boots réels par fichier : on les exécute l'un après l'autre pour ne
  // pas saturer la machine hôte avec plusieurs VM émulées simultanées.
  test.describe.configure({ mode: 'serial' });

  test('DHCP/DNS OK, HTTP OK, HTTPS et apt en échec (limites v86/CORS)', async ({ page }) => {
    // Boot + sondes réseau + échecs bornés : budget mural explicite.
    test.setTimeout(900_000);

    const serial = await bootDebianAndWaitForPrompt(page);

    // NIC virtio de Debian : l'interface `enp0s10` est UP et porte une adresse
    // RFC1918 (`192.168.x.y`) attribuée par DHCP.
    const addr = await probe(serial, 'ip -br addr', 'NET_ADDR', 30_000);
    expect(addr).toMatch(/enp0s10\s+UP/);
    expect(addr).toMatch(/192\.168\.\d+\.\d+/);

    const route = await probe(serial, 'ip route', 'NET_ROUTE', 30_000);
    expect(route).toMatch(/192\.168\.\d+\.\d+/);

    // DNS : le nom doit se résoudre via systemd-resolved, sans requête Internet.
    const dns = await probe(serial, 'getent hosts deb.debian.org', 'NET_DNS', 30_000);
    expect(dns).toMatch(/\d+\.\d+\.\d+\.\d+/);

    // HTTP (port 80) : c'est le SEUL port que le backend `fetch` de v86
    // transporte. `httpbin.org` renvoie `Access-Control-Allow-Origin: *`, donc
    // la requête aboutit réellement. On exige une réponse httpbin valide et
    // aucune erreur curl.
    const http = await probe(
      serial,
      'curl -sS --max-time 20 http://httpbin.org/get',
      'NET_HTTP',
      45_000,
    );
    expect(http).toMatch(/"url"/);
    expect(http).not.toMatch(/curl: \(\d+\)/);

    // HTTPS (443) : aucune connexion TCP n'est enregistrée pour 443 par v86
    // 0.5.471, donc curl échoue (code `000` et/ou erreur `curl: (...)`).
    // On refuse explicitement tout code 2xx/3xx : un succès serait un mensonge.
    const https = await probe(
      serial,
      "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://deb.debian.org/",
      'NET_HTTPS',
      45_000,
    );
    expect(https).toMatch(/curl: \(\d+\)|000/);
    expect(https).not.toMatch(/\b(200|204|301|302|304)\b/);

    // `apt-get update` interroge les dépôts : le transport HTTP échoue car les
    // hôtes concernés n'envoient pas d'en-tête CORS. Échec attendu, pas un bug.
    const apt = await probe(serial, 'sudo apt-get update', 'NET_APT', 240_000);
    expect(apt).toMatch(/Err:|E: /);

    // Arrêt propre : la session doit atteindre `stopped` sans rester bloquée.
    await page.getByRole('button', { name: 'Arrêter' }).click();
    await expect(page.locator('.session-toolbar')).toHaveAttribute('data-state', 'stopped', {
      timeout: 60_000,
    });
  });

  test('un relais injoignable ne bloque pas le cycle de vie (démarrage, Arrêter, Redémarrer)', async ({
    page,
  }) => {
    test.setTimeout(900_000);

    // On force un mode `user-relay` pointant vers un relais **volontairement
    // injoignable** (`127.0.0.1:9`, port discard). v86 ouvre la WebSocket en
    // asynchrone : son échec ne doit pas empêcher l'émulateur de démarrer.
    // La config est interceptée au niveau du réseau Playwright : le fichier
    // public n'est PAS modifié (isolé des autres specs exécutées en parallèle).
    await page.route('**/lumiboot.config.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          network: {
            defaultProfile: { mode: 'user-relay', relayUrl: 'wss://127.0.0.1:9/' },
            systems: {},
          },
        }),
      }),
    );

    // DHCP/network-online peuvent expirer plus lentement sans relais : budget
    // de démarrage plus large que pour `browser-fetch`.
    const serial = await bootDebianAndWaitForPrompt(page, 300_000);
    await expect(serial).toHaveValue(/lumiboot@lumiboot/);

    const state = page.locator('.session-toolbar');

    // Arrêter puis redémarrer : le cycle de vie reste fonctionnel malgré le
    // relais injoignable (aucun blocage, aucune ressource bloquante).
    await page.getByRole('button', { name: 'Arrêter' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Redémarrer' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 300_000 });
  });
});
