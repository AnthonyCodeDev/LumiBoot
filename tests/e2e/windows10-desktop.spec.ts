import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Windows 10 sous v86 — fiche groupée et boot réel EXPÉRIMENTAL.
 *
 * Ce fichier couvre deux niveaux, volontairement séparés :
 *
 * 1. **Sans disque** (toujours exécuté) : la fiche groupée Windows 10 expose la
 *    mère x86 par défaut, la variante x64 (future) n'est PAS annoncée
 *    disponible, et le lancement x86 est bloqué honnêtement quand le disque
 *    n'est pas servi (manifeste 404). Aucun faux `ready`, aucun faux `passed`.
 *
 * 2. **Avec un vrai disque** (opt-in) : uniquement si `VM_E2E_ASSETS=1` ET
 *    qu'un disque Windows 10 x86 est présent (variable `WIN10_DISK` ou
 *    `images/windows-10-x86/manifest.json` en `boot.mode === 'disk-boot'`).
 *    Le test vérifie le manifeste HTTP 200 JSON, le disque en HTTP Range 206,
 *    démarre une session RÉELLE (`data-state=running`, émis après une lecture
 *    disque `ide-read-end`) et capture l'écran VGA + les logs. Sans l'un des
 *    deux garde-fous, le test est **ignoré** (jamais « réussi »).
 *
 * Windows 10 x86 porte `validated: false` (aucun boot prouvé à ce jour) : ce
 * fichier ne force JAMAIS `validated` et ne présente JAMAIS l'écran VGA coloré
 * comme une preuve garantie de bureau. Le parcours Windows 7
 * (`windows7-desktop.spec.ts`) reste inchangé et fait foi pour Windows 7.
 *
 * Commande du boot réel :
 *
 *   $env:VM_E2E_ASSETS='1'; $env:WIN10_DISK='1'; pnpm exec playwright test tests/e2e/windows10-desktop.spec.ts
 */

// ---------------------------------------------------------------------------
// Garde-fous d'exécution (disque réel présent ou non)
// ---------------------------------------------------------------------------

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Vrai si une variable d'environnement est « activée » (non vide, pas 0/false). */
function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** Remonte l'arborescence jusqu'à la racine du dépôt (marqueur pnpm-workspace). */
function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO_ROOT = findRepoRoot(process.cwd()) ?? process.cwd();
const WIN10_REF = 'windows-10-x86';
const WIN10_SYSTEM_SLUG = 'windows-10-x86';
const WIN10_X64_SLUG = 'windows-10-x64';
const WIN10_MANIFEST_URL = `/images/${WIN10_REF}/manifest.json`;
const WIN10_DISK_URL = process.env.WIN10_DISK_URL?.trim() || `/images/${WIN10_REF}/disk.img`;

interface PrivateDiskManifest {
  readonly boot?: { readonly mode?: unknown } | undefined;
}

/**
 * Détecte un disque Windows 10 x86 présent sur le poste : soit `WIN10_DISK` est
 * activé, soit un manifeste `disk-boot` existe sous `images/windows-10-x86/`.
 * C'est un pré-requis du boot réel : sans lui, aucun test de démarrage n'est
 * lancé (skip explicite, jamais un succès).
 */
function detectWin10Disk(): boolean {
  if (envFlagEnabled('WIN10_DISK')) return true;
  const manifestPath = join(REPO_ROOT, 'images', WIN10_REF, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PrivateDiskManifest;
    return manifest.boot?.mode === 'disk-boot';
  } catch {
    return false;
  }
}

const win10DiskPresent = detectWin10Disk();

// ---------------------------------------------------------------------------
// Budgets temporels (émulation logicielle : très large)
// ---------------------------------------------------------------------------

const RUNNING_TIMEOUT_MS = 900_000;
const SCREEN_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 60_000;

// Seuils du signal visuel. Ils ne sont PAS une preuve de bureau : ils
// complètent la preuve machine (lecture disque réelle) par un écran coloré ET
// stable. Un installateur ou un écran de connexion animé ne tient pas la
// stabilité exigée, et n'est donc jamais compté comme un bureau.
const MIN_NON_BLACK_RATIO = 0.3;
const MIN_DISTINCT_COLORS = 32;
const REQUIRED_STABLE_POLLS = 4;
const POLL_INTERVAL_MS = 1_500;
/** Points d'empreinte qui peuvent changer sans casser la stabilité (bruit/curseur). */
const MAX_CHANGED_SAMPLES = 6;

interface CanvasSample {
  readonly nonBlackRatio: number;
  readonly distinctColors: number;
  /** Empreinte compacte (64 points, 4 bits/canal) pour juger la stabilité. */
  readonly signature: number[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/** Lit un instantané du canvas VGA 2D réel (jamais un faux écran React). */
async function sampleCanvas(page: Page): Promise<CanvasSample | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.v86-screen-canvas');
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
    const style = getComputedStyle(canvas);
    if (style.display === 'none' || style.visibility === 'hidden') return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch {
      return null;
    }

    const stride = 4;
    const step = 4 * stride;
    let total = 0;
    let nonBlack = 0;
    const colors = new Set<number>();
    for (let i = 0; i + 2 < data.length; i += step) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      total += 1;
      if (r + g + b > 30) nonBlack += 1;
      // Quantification 3 bits/canal (comme la mesure de colorimétrie).
      colors.add(((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5));
    }
    if (total === 0) return null;

    const signature: number[] = [];
    const samples = 64;
    const pixels = canvas.width * canvas.height;
    for (let s = 0; s < samples; s += 1) {
      const pixel = Math.floor(((pixels - 1) * s) / (samples - 1));
      const i = pixel * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      signature.push(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }

    return {
      nonBlackRatio: nonBlack / total,
      distinctColors: colors.size,
      signature,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  });
}

/** Nombre de points d'empreinte ayant significativement changé entre deux polls. */
function changedSamples(previous: readonly number[], current: readonly number[]): number {
  const length = Math.min(previous.length, current.length);
  let changed = Math.abs(previous.length - current.length);
  for (let i = 0; i < length; i += 1) {
    const a = previous[i]!;
    const b = current[i]!;
    const dr = Math.abs(((a >> 8) & 0xf) - ((b >> 8) & 0xf));
    const dg = Math.abs(((a >> 4) & 0xf) - ((b >> 4) & 0xf));
    const db = Math.abs((a & 0xf) - (b & 0xf));
    if (dr + dg + db > 2) changed += 1;
  }
  return changed;
}

interface ScreenProof {
  readonly proven: boolean;
  readonly nonBlackRatio: number | null;
  readonly distinctColors: number | null;
  readonly stablePolls: number;
  readonly canvasWidth: number | null;
  readonly canvasHeight: number | null;
}

/**
 * Attend un écran VGA coloré ET STABLE. La stabilité (plusieurs polls
 * consécutifs quasi identiques) est ce qui distingue un écran posé d'une
 * animation d'installateur/écran de connexion animé. Reste un signal visuel,
 * jamais une garantie de « bureau » : la preuve machine est la lecture disque
 * réelle (`running` en `disk-boot` + requêtes HTTP Range).
 */
async function waitForStableColorScreen(page: Page): Promise<ScreenProof> {
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  let previous: CanvasSample | null = null;
  let last: CanvasSample | null = null;
  let stablePolls = 0;

  while (Date.now() < deadline) {
    const sample = await sampleCanvas(page).catch(() => null);
    if (
      sample !== null &&
      sample.nonBlackRatio > MIN_NON_BLACK_RATIO &&
      sample.distinctColors > MIN_DISTINCT_COLORS
    ) {
      last = sample;
      stablePolls =
        previous !== null &&
        changedSamples(previous.signature, sample.signature) <= MAX_CHANGED_SAMPLES
          ? stablePolls + 1
          : 1;
      if (stablePolls >= REQUIRED_STABLE_POLLS) {
        return {
          proven: true,
          nonBlackRatio: sample.nonBlackRatio,
          distinctColors: sample.distinctColors,
          stablePolls,
          canvasWidth: sample.canvasWidth,
          canvasHeight: sample.canvasHeight,
        };
      }
    } else {
      stablePolls = 0;
    }
    if (sample !== null) previous = sample;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  return {
    proven: false,
    nonBlackRatio: last?.nonBlackRatio ?? null,
    distinctColors: last?.distinctColors ?? null,
    stablePolls,
    canvasWidth: last?.canvasWidth ?? null,
    canvasHeight: last?.canvasHeight ?? null,
  };
}

/**
 * Compteur des octets disque réellement servis par HTTP Range. On compte les
 * vraies réponses HTTP (`page.on('response')`) et la somme de leur
 * `Content-Length`, car `performance.transferSize` sous-compte fortement les
 * XHR par plages de v86.
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
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? null;
  });
}

/** Attache les diagnostics bruts en cas d'échec (jamais de signal simulé). */
async function attachDiagnostics(page: Page, consoleLogs: string[]): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('windows10-v86-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('windows10-console', {
    body: consoleLogs.join('\n') || '(aucun message console)',
    contentType: 'text/plain',
  });

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'inconnu';
  await info.attach('windows10-session-state', {
    body: `data-state=${sessionState}`,
    contentType: 'text/plain',
  });

  const screen = page.locator('.v86-screen');
  if ((await screen.count()) > 0) {
    const shot = await screen.screenshot().catch(() => null);
    if (shot) await info.attach('windows10-vga-canvas', { body: shot, contentType: 'image/png' });
  }
}

/** Carte de la mère Windows 10 dans la grille, après recherche « windows ». */
async function openWindows10Mother(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByLabel('Rechercher un système').fill('windows');
  return page.locator(`.os-card[data-id="${WIN10_SYSTEM_SLUG}"]`);
}

// ---------------------------------------------------------------------------
// 1. Fiche groupée, sans disque — toujours exécuté
// ---------------------------------------------------------------------------

test.describe('Windows 10 : fiche groupée et disponibilité (sans disque)', () => {
  test('expose x86 par défaut, x64 non intégré et bloque honnêtement le lancement sans disque', async ({
    page,
  }) => {
    // Force l'absence du disque, même si l'opérateur en possède un localement :
    // le cas testé est « aucune fausse disponibilité sans média servi ».
    await page.route(new RegExp(`/images/${WIN10_REF}/manifest\\.json(?:\\?.*)?$`), (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    const card = await openWindows10Mother(page);
    if ((await card.count()) === 0) {
      test.skip(
        true,
        `Groupe « ${WIN10_SYSTEM_SLUG} » absent du catalogue : aucune preuve possible ` +
          '(skip honnête, jamais un succès).',
      );
    }
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/systems/${WIN10_SYSTEM_SLUG}$`));

    // 1. Le groupe expose exactement deux variantes : x86 (mère, défaut) + x64
    //    (future, non intégrée). La sélection par défaut est l'AUTRE que x64.
    const trigger = page.getByRole('button', { name: 'Choisir la variante' });
    await expect(trigger).toBeVisible();
    const defaultLabel = ((await trigger.textContent()) ?? '').trim();

    await trigger.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    const labels = (await options.allInnerTexts()).map((text) => text.trim());
    const x64Index = labels.findIndex((label) => /64\s*bits/i.test(label));
    expect(
      x64Index,
      `Aucune variante x64 dans le groupe Windows 10 (${labels.join(' | ')}).`,
    ).toBeGreaterThanOrEqual(0);

    const selected = page.getByRole('option', { selected: true });
    await expect(selected).toHaveCount(1);
    const selectedLabel = ((await selected.innerText()) ?? '').trim();
    // La variante sélectionnée par défaut n'est PAS x64 (c'est x86).
    expect(selectedLabel).not.toBe(labels[x64Index]);
    // Le déclencheur reflète bien cette sélection par défaut.
    expect(defaultLabel).toBe(selectedLabel);
    await page.keyboard.press('Escape');

    // 2. La mère x86 non validée n'est JAMAIS annoncée « Disponible ».
    const stateValue = page
      .locator('.spec-box > div')
      .filter({ hasText: 'État' })
      .locator('strong');
    await expect(stateValue).toBeVisible();
    await expect(stateValue).not.toHaveText('Disponible');

    // 3. Sans disque servi (manifeste 404), le lancement est bloqué avec une
    //    raison explicite : aucune fausse disponibilité.
    const launch = page.getByRole('button', { name: 'Lancer une session' });
    await expect(launch).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /manifeste.*absent|manifeste.*indisponible/i }),
    ).toBeVisible();
  });

  test('la variante x64 est refusée explicitement (moteur x86-64 non intégré)', async ({
    page,
  }) => {
    await page.goto(`/systems/${WIN10_X64_SLUG}`);
    const launch = page.getByRole('button', { name: 'Lancer une session' });
    if ((await launch.count()) === 0) {
      test.skip(true, `Fiche « ${WIN10_X64_SLUG} » absente : rien à prouver (skip honnête).`);
    }
    await expect(launch).toBeDisabled();
    // Raison explicite : moteur non intégré (et/ou média utilisateur requis).
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /n'est pas encore intégré|Ressource requise|importez un média/i }),
    ).toBeVisible();
    const stateValue = page
      .locator('.spec-box > div')
      .filter({ hasText: 'État' })
      .locator('strong');
    await expect(stateValue).not.toHaveText('Disponible');
  });
});

// ---------------------------------------------------------------------------
// 2. Boot réel expérimental — opt-in (disque présent)
// ---------------------------------------------------------------------------

test.describe('Windows 10 x86 : boot réel expérimental (v86)', () => {
  test.skip(!assetsPresent, 'Disques locaux absents : définir VM_E2E_ASSETS=1.');
  test.skip(
    !win10DiskPresent,
    `Disque « ${WIN10_REF} » absent : définir WIN10_DISK=1 ou fournir ` +
      `images/${WIN10_REF}/manifest.json (boot.mode = disk-boot).`,
  );

  test('sert le manifeste (200 JSON) et le disque (206 Range), puis démarre une session réelle', async ({
    page,
    request,
  }) => {
    test.setTimeout(1_800_000);

    const consoleLogs: string[] = [];
    page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));

    try {
      // 0. Preuves serveur AVANT toute UI : manifeste JSON valide + disque servi
      //    en HTTP Range (206), jamais un 200 complet que v86 ne saurait lire.
      const manifestResponse = await request.get(WIN10_MANIFEST_URL);
      expect(
        manifestResponse.status(),
        `Manifeste ${WIN10_MANIFEST_URL} non servi (HTTP 200 attendu).`,
      ).toBe(200);
      expect(manifestResponse.headers()['content-type'] ?? '').toContain('application/json');
      const manifestBody = (await manifestResponse.json()) as {
        ref?: unknown;
        architecture?: unknown;
        boot?: { mode?: unknown } | undefined;
      };
      expect(manifestBody.ref).toBe(WIN10_REF);
      expect(manifestBody.architecture).toBe('i386');
      expect(manifestBody.boot?.mode).toBe('disk-boot');

      const rangeResponse = await request.get(WIN10_DISK_URL, {
        headers: { Range: 'bytes=0-511' },
      });
      expect(
        rangeResponse.status(),
        `${WIN10_DISK_URL} doit répondre 206 (HTTP Range), jamais un 200 complet.`,
      ).toBe(206);
      expect(rangeResponse.headers()['accept-ranges']).toBe('bytes');
      expect(rangeResponse.headers()['content-range'] ?? '').toMatch(/^bytes 0-511\//);
      expect(
        (await rangeResponse.body()).byteLength,
        'Le serveur doit renvoyer exactement 512 octets pour la plage demandée.',
      ).toBe(512);

      // 1. Parcours UI : recherche « windows » → carte de la mère x86.
      const card = await openWindows10Mother(page);
      if ((await card.count()) === 0) {
        test.skip(
          true,
          `Carte « ${WIN10_SYSTEM_SLUG} » absente : impossible de démarrer la session ` +
            '(skip honnête, jamais un succès).',
        );
      }
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/systems/${WIN10_SYSTEM_SLUG}$`));

      // 2. Lancement : disque bundled local, aucun import de média.
      const launchButton = page.getByRole('button', { name: 'Lancer une session' });
      await expect(launchButton).toBeEnabled();
      const diskBytes = createDiskByteCounter(page, `/images/${WIN10_REF}/disk`);
      const bootStartedAt = Date.now();
      await launchButton.click();
      await expect(page).toHaveURL(/\/session\//);
      await expect(page.locator('.session-console')).toBeVisible();

      // 3. `running` en `disk-boot` n'est émis qu'après une lecture disque RÉELLE
      //    (`ide-read-end`), jamais simulé par un timer React.
      const state = page.locator('.session-toolbar');
      await expect(state).toHaveAttribute('data-state', 'running', {
        timeout: RUNNING_TIMEOUT_MS,
      });

      // 4. Signal visuel renforcé : écran coloré ET STABLE (une animation
      //    d'installateur/écran de connexion animé ne tient pas la stabilité).
      const proof = await waitForStableColorScreen(page);
      const bootMs = Date.now() - bootStartedAt;

      // 5. Preuve machine : le disque attendu a réellement été lu en HTTP Range.
      const disk = diskBytes();
      const heap = await heapUsedBytes(page);
      expect(
        disk.requests,
        `Aucune requête HTTP Range pour ${WIN10_DISK_URL} (disque attendu non lu).`,
      ).toBeGreaterThan(0);

      // Captures de preuve (écran VGA réel + logs), succès comme diagnostic.
      await test.info().attach('windows10-x86-vga-canvas', {
        body: await page.locator('.v86-screen').screenshot(),
        contentType: 'image/png',
      });
      await test.info().attach('windows10-x86-serial', {
        body:
          (await page
            .locator('textarea.v86-serial')
            .inputValue()
            .catch(() => '')) || '(aucune sortie série)',
        contentType: 'text/plain',
      });
      await test.info().attach('windows10-x86-console', {
        body: consoleLogs.join('\n') || '(aucun message console)',
        contentType: 'text/plain',
      });

      console.log(
        `\n=== Windows 10 x86 (expérimental, non validé) ===\n` +
          `  disque attendu                : ${WIN10_DISK_URL}\n` +
          `  temps de boot (clic → écran)  : ${(bootMs / 1000).toFixed(1)} s\n` +
          `  écran VGA coloré et stable    : ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
          `nonBlackRatio=${proof.nonBlackRatio?.toFixed(3)} distinctColors=${proof.distinctColors} ` +
          `stablePolls=${proof.stablePolls} (seuils > ${MIN_NON_BLACK_RATIO} / > ${MIN_DISTINCT_COLORS}, ` +
          `${REQUIRED_STABLE_POLLS} polls stables)\n` +
          `  disque servi (Range)          : ${disk.bytes} octets ` +
          `(${(disk.bytes / 1048576).toFixed(2)} Mio) en ${disk.requests} requêtes\n` +
          `  tas JS utilisé                : ${heap === null ? 'indisponible' : `${heap} octets`}\n` +
          `  RAM invitée                   : 2048 Mio\n` +
          `  NB : écran coloré/stable ≠ preuve garantie de bureau ; ` +
          `validated reste false.\n` +
          `=== fin mesures ===\n`,
      );

      // Le signal visuel est vérifié APRÈS les mesures pour joindre les
      // diagnostics bruts (catch) en cas d'échec, sans masquer la vraie cause.
      expect(
        proof.proven,
        `Aucun écran VGA coloré et stable pour Windows 10 x86 : le canvas ` +
          `.v86-screen-canvas n'a pas tenu ${REQUIRED_STABLE_POLLS} polls stables ` +
          `(nonBlackRatio > ${MIN_NON_BLACK_RATIO}, distinctColors > ${MIN_DISTINCT_COLORS}) ` +
          `en ${bootMs} ms. Un écran animé (installateur/écran de connexion) ne compte ` +
          `PAS comme un bureau.`,
      ).toBe(true);

      // 6. Entrées réelles puis arrêt propre.
      const screen = page.locator('.v86-screen');
      await screen.click();
      await page.evaluate(() => document.exitPointerLock()).catch(() => undefined);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Arrêter' }).click();
      await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
    } catch (error) {
      await attachDiagnostics(page, consoleLogs);
      throw error;
    }
  });
});
