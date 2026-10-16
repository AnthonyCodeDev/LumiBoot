import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Boot RÉEL du groupe Windows 7 dans v86, depuis les disques RAW locaux
 * (`images/windows-7-x86/disk.img` 16 Gio et
 * `images/windows-7-pro-sp1-x86/disk.img` 32 Gio, hors `public/`).
 *
 * Ce fichier n'est activé que lorsque les disques sont réellement présents et
 * servis en HTTP Range :
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm exec playwright test tests/e2e/windows7-desktop.spec.ts
 *
 * Sans cette variable, les tests sont **ignorés** (pas « réussis ») : sans
 * disque, aucune preuve possible.
 *
 * Contrairement à Debian, Windows n'émet AUCUN marqueur LumiBoot. La preuve de
 * « bureau » est donc **visuelle** : le canvas VGA 2D de v86 (le vrai écran de
 * la machine émulée, jamais un faux bureau React) doit montrer une image
 * colorée et stable (et non un écran noir de POST / un simple curseur texte).
 *
 * Le parcours est factorisé dans `bootWindowsDesktop` (navigation, sélection de
 * variante, lancement, attente, preuve visuelle, mesures) et paramétré par le
 * libellé de variante et le fragment d'URL du disque attendu.
 */

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Émulation logicielle (sans accélération) : budget mural très large. */
const RUNNING_TIMEOUT_MS = 900_000;
const DESKTOP_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 60_000;

/**
 * Un « bureau » est retenu quand, sur **3 polls consécutifs**, le canvas est
 * visible, majoritairement non noir (`nonBlackRatio > 0.5`) et suffisamment
 * coloré (`distinctColors > 64`, couleurs quantifiées en 3 bits/canal).
 *
 * Le compteur de polls vit sur `window` car `waitForFunction` réévalue la
 * fonction à chaque poll sans conserver d'état de closure.
 */
export interface DesktopMetrics {
  /** Vrai si le bureau a été prouvé sur `consecutive` polls. */
  readonly proven: boolean;
  /** Mesures du dernier poll concluant (null si non prouvé). */
  readonly nonBlackRatio: number | null;
  readonly distinctColors: number | null;
  /** Résolution native du canvas au moment de la preuve. */
  readonly canvasWidth: number | null;
  readonly canvasHeight: number | null;
}

async function waitForDesktopProof(page: Page): Promise<DesktopMetrics> {
  try {
    const handle = await page.waitForFunction(
      ({ minNonBlackRatio, minDistinctColors, consecutive, stride }) => {
        const state = window as unknown as { __lumibootWin7Polls?: number };
        // `null` = « pas encore » : on continue de poller.
        const reset = (): null => {
          state.__lumibootWin7Polls = 0;
          return null;
        };

        const canvas = document.querySelector<HTMLCanvasElement>('.v86-screen-canvas');
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) return reset();

        const style = getComputedStyle(canvas);
        if (style.display === 'none' || style.visibility === 'hidden') return reset();
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return reset();

        const ctx = canvas.getContext('2d');
        if (!ctx) return reset();

        let data: Uint8ClampedArray;
        try {
          data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch {
          return reset();
        }

        let total = 0;
        let nonBlack = 0;
        const colors = new Set<number>();
        const step = 4 * stride;
        for (let i = 0; i + 2 < data.length; i += step) {
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          total += 1;
          if (r + g + b > 30) nonBlack += 1;
          // Quantification 3 bits/canal (les 3 bits de poids faible sont fusionnés).
          colors.add(((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5));
        }
        if (total === 0) return reset();

        const nonBlackRatio = nonBlack / total;
        const distinctColors = colors.size;
        if (nonBlackRatio > minNonBlackRatio && distinctColors > minDistinctColors) {
          state.__lumibootWin7Polls = (state.__lumibootWin7Polls ?? 0) + 1;
        } else {
          state.__lumibootWin7Polls = 0;
        }
        // Un bureau n'est retenu qu'après `consecutive` polls positifs d'affilée.
        if (state.__lumibootWin7Polls >= consecutive) {
          // Mesures du poll concluant (mêmes seuils, aucune relaxation).
          return {
            nonBlackRatio,
            distinctColors,
            canvasWidth: canvas.width,
            canvasHeight: canvas.height,
          };
        }
        return null;
      },
      { minNonBlackRatio: 0.5, minDistinctColors: 64, consecutive: 3, stride: 4 },
      { timeout: DESKTOP_TIMEOUT_MS, polling: 1_000 },
    );
    const metrics = (await handle.jsonValue()) as {
      nonBlackRatio: number;
      distinctColors: number;
      canvasWidth: number;
      canvasHeight: number;
    };
    return { proven: true, ...metrics };
  } catch {
    return {
      proven: false,
      nonBlackRatio: null,
      distinctColors: null,
      canvasWidth: null,
      canvasHeight: null,
    };
  }
}

/**
 * Compteur des octets disque réellement servis par HTTP Range pour le disque
 * attendu (`diskUrlFragment`).
 *
 * `performance.transferSize` SOUS-COMPTE fortement les XHR par plages de v86
 * (constaté : ~97 Kio rapportés pour ~193 Mio réellement servis). On compte donc
 * les vraies réponses HTTP (`page.on('response')`) et la somme de leur
 * `Content-Length`, ce qui reflète le trafic Range effectif.
 */
function createDiskByteCounter(
  page: Page,
  diskUrlFragment: string,
): () => { bytes: number; requests: number } {
  let bytes = 0;
  let requests = 0;
  page.on('response', (response) => {
    if (!response.url().includes(diskUrlFragment)) return;
    requests += 1;
    const length = Number(response.headers()['content-length'] ?? '0');
    if (Number.isFinite(length)) bytes += length;
  });
  return () => ({ bytes, requests });
}

/** Octets JS réellement utilisés (non standard, best-effort). */
async function heapUsedBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    return perf.memory?.usedJSHeapSize ?? null;
  });
}

/** Attache les diagnostic bruts en cas d'échec (jamais de signal simulé). */
async function attachDiagnostics(page: Page, consoleLogs: string[]): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('v86-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('console', {
    body: consoleLogs.join('\n') || '(aucun message console)',
    contentType: 'text/plain',
  });

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'inconnu';
  await info.attach('session-state', {
    body: `data-state=${sessionState}`,
    contentType: 'text/plain',
  });

  const screen = page.locator('.v86-screen');
  if ((await screen.count()) > 0) {
    const shot = await screen.screenshot().catch(() => null);
    if (shot) await info.attach('vga-canvas', { body: shot, contentType: 'image/png' });
  }
}

export interface WindowsBootOptions {
  /** Libellé exact de la variante à sélectionner (absent = variante par défaut). */
  readonly variantLabel?: string;
  /** Fragment d'URL du disque attendu pour ce boot. */
  readonly diskUrlFragment: string;
  /** Nom du screenshot VGA attaché (preuve visuelle). */
  readonly screenshotName: string;
  /** Titre imprimé dans les mesures. */
  readonly title: string;
  /** RAM invitée demandée au moteur (cf. profil catalogue). */
  readonly guestRamMiB: number;
}

export interface WindowsBootResult {
  readonly bootMs: number;
  readonly disk: { bytes: number; requests: number };
  readonly heap: number | null;
  readonly state: Locator;
}

/**
 * Parcours complet et prouvé d'une variante Windows 7 : bibliothèque →
 * recherche « windows » → carte de la mère `windows-7-x86` → sélection
 * éventuelle de variante → lancement → `running` → preuve visuelle du bureau
 * (canvas VGA 2D réel) → mesures (temps, octets disque via réponses HTTP,
 * mémoire). En cas d'échec, les diagnostics bruts sont attachés.
 */
async function bootWindowsDesktop(
  page: Page,
  options: WindowsBootOptions,
): Promise<WindowsBootResult> {
  const consoleLogs: string[] = [];
  page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));
  // Enregistré AVANT le clic de lancement pour compter tous les Range du disque.
  const diskBytes = createDiskByteCounter(page, options.diskUrlFragment);

  try {
    // 1. Parcours : bibliothèque → recherche « windows » → carte de la mère.
    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('windows');
    await page.locator('.os-card[data-id="windows-7-x86"]').click();
    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);

    // 2. Sélection éventuelle de la variante via le dropdown custom : elle ne
    //    navigue PAS (on reste sur la fiche de la mère).
    if (options.variantLabel) {
      await page.getByRole('button', { name: 'Choisir la variante' }).click();
      await page.getByRole('button', { name: options.variantLabel, exact: true }).click();
      await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
    }

    // 3. Lancement : aucune import de média, disque bundled de la codebase.
    const launchButton = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launchButton).toBeEnabled();
    const bootStartedAt = Date.now();
    await launchButton.click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(page.locator('.session-console')).toBeVisible();

    // 4. `running` n'est émis qu'après une lecture disque réelle (ide-read-end),
    //    jamais simulé par un timer React.
    const state = page.locator('.session-toolbar');
    await expect(state).toHaveAttribute('data-state', 'running', {
      timeout: RUNNING_TIMEOUT_MS,
    });

    // 5. Preuve visuelle : le canvas VGA 2D montre un bureau coloré et stable.
    const proof = await waitForDesktopProof(page);
    const bootMs = Date.now() - bootStartedAt;
    // En cas d'échec, le `catch` ci-dessous joint les diagnostics bruts.
    expect(
      proof.proven,
      `Aucun bureau VGA prouvé pour « ${options.title} » : le canvas ` +
        `.v86-screen-canvas n'a pas atteint nonBlackRatio > 0.5 / distinctColors > 64 ` +
        `sur 3 polls consécutifs (temps écoulé : ${bootMs} ms).`,
    ).toBe(true);

    // Screenshot du vrai écran v86 (canvas 2D), jamais un faux bureau React.
    await test.info().attach(options.screenshotName, {
      body: await page.locator('.v86-screen').screenshot(),
      contentType: 'image/png',
    });

    // 6. Mesures : temps de boot, octets disque réellement servis, mémoire.
    const disk = diskBytes();
    const heap = await heapUsedBytes(page);
    // Le disque attendu DOIT avoir été réellement servi en HTTP Range.
    expect(
      disk.requests,
      `Aucune requête HTTP Range pour « ${options.diskUrlFragment} » ` +
        `(disque attendu non servi).`,
    ).toBeGreaterThan(0);
    console.log(
      `\n=== ${options.title} ===\n` +
        `  disque attendu                : ${options.diskUrlFragment}\n` +
        `  temps de boot (clic → bureau) : ${(bootMs / 1000).toFixed(1)} s\n` +
        `  bureau VGA (canvas 2D)        : ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
        `nonBlackRatio=${proof.nonBlackRatio?.toFixed(3)} distinctColors=${proof.distinctColors} ` +
        `(seuils > 0.5 / > 64 sur 3 polls)\n` +
        `  disque servi (Range)          : ${disk.bytes} octets ` +
        `(${(disk.bytes / 1048576).toFixed(2)} Mio) en ${disk.requests} requêtes\n` +
        `  tas JS utilisé               : ${heap === null ? 'indisponible' : `${heap} octets`}\n` +
        `  RAM invitée                  : ${options.guestRamMiB} Mio\n` +
        `=== fin mesures ===\n`,
    );

    return { bootMs, disk, heap, state };
  } catch (error) {
    await attachDiagnostics(page, consoleLogs);
    throw error;
  }
}

/**
 * Étapes post-boot communes : entrées réelles (souris/clavier atteignent
 * l'écran émulé), capture Pointer Lock (un seul curseur : celui de l'invité),
 * plein écran disponible, puis arrêt propre.
 */
async function exerciseAndStop(page: Page, state: Locator): Promise<void> {
  const screen = page.locator('.v86-screen');

  // Un clic explicite dans l'écran capture le pointeur : le navigateur masque
  // le curseur hôte et v86 reçoit les mouvements RELATIFS (même aux bords).
  await screen.click();
  await expect
    .poll(() =>
      page.evaluate(() => document.pointerLockElement?.classList.contains('v86-screen') ?? false),
    )
    .toBe(true);

  // Échap est géré nativement par le navigateur ; en Chromium headless il n'est
  // pas intercepté, on libère donc explicitement (même chemin `pointerlockchange`
  // que celui déclenché par Échap en session réelle).
  await page.evaluate(() => document.exitPointerLock());
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('button', { name: 'Plein écran' })).toBeVisible();

  await page.getByRole('button', { name: 'Arrêter' }).click();
  await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
}

test.describe('Session Windows 7 (v86, boot réel)', () => {
  test.skip(!assetsPresent, 'Disques Windows 7 absents : définir VM_E2E_ASSETS=1.');

  test('démarre la variante par défaut (Professionnel) depuis le disque RAW 32 Gio et s’arrête', async ({
    page,
  }) => {
    // Boot Windows complet sous émulation logicielle : budget mural explicite.
    test.setTimeout(1_800_000);

    // Aucune variante sélectionnée : la mère ouvre la meilleure variante
    // (Professionnel, `variantOrder: 1`).
    const { state } = await bootWindowsDesktop(page, {
      diskUrlFragment: '/images/windows-7-pro-sp1-x86/disk.img',
      screenshotName: 'windows7-professionnel-desktop',
      title: 'Windows 7 Professionnel SP1 x86',
      guestRamMiB: 1536,
    });

    await exerciseAndStop(page, state);
  });

  test('bascule sur la variante Lite et démarre le disque RAW 16 Gio', async ({ page }) => {
    test.setTimeout(1_800_000);

    // On sélectionne explicitement « Lite » dans le dropdown, puis on lance.
    const { state } = await bootWindowsDesktop(page, {
      variantLabel: 'Windows 7 Lite',
      diskUrlFragment: '/images/windows-7-x86/disk.img',
      screenshotName: 'windows7-lite-desktop',
      title: 'Windows 7 Lite x86',
      guestRamMiB: 1024,
    });

    await exerciseAndStop(page, state);
  });
});
