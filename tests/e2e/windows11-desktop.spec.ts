import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Windows 11 x64 under v64 + OVMF: standalone card always tested, real boot opt-in.

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Walks up the tree to the repository root, located by the `pnpm-workspace.yaml` marker. */
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
const REF = 'windows-11-x64';
const SYSTEM_SLUG = 'windows-11-x64';
const MANIFEST_URL = `/images/${REF}/manifest.json`;
const DISK_URL = `/images/${REF}/disk.img`;
const UEFI_VARS_URL = `/images/${REF}/uefi-vars.fd`;
const DISK_PATH = join(REPO_ROOT, 'images', REF, 'disk.img');
/** RAW disk size announced by the local manifest (64 GiB). */
const DISK_SIZE_BYTES = 68_719_476_736;

interface PrivateDiskManifest {
  readonly boot?: { readonly mode?: unknown } | undefined;
}

/** True when a local `disk-boot` manifest exists under images/. */
function detectWin11Disk(): boolean {
  const manifestPath = join(REPO_ROOT, 'images', REF, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PrivateDiskManifest;
    return manifest.boot?.mode === 'disk-boot';
  } catch {
    return false;
  }
}

// A real disk boot needs the opt-in assets AND a local `disk-boot` manifest.
const win11DiskPresent = assetsPresent && detectWin11Disk();

const RUNNING_TIMEOUT_MS = 900_000;
// Much longer than Windows 10: v64 + OVMF on a 64 GiB disk is slower to settle.
const SCREEN_TIMEOUT_MS = 2_400_000;
const STOP_TIMEOUT_MS = 60_000;

// Visual signal only, never a desktop proof: a colored AND stable screen is required.
const MIN_NON_BLACK_RATIO = 0.3;
const MIN_DISTINCT_COLORS = 32;
const REQUIRED_STABLE_POLLS = 4;
const POLL_INTERVAL_MS = 2_000;
/** Fingerprint points that may change without breaking stability (noise, cursor). */
const MAX_CHANGED_SAMPLES = 6;

interface CanvasSample {
  readonly nonBlackRatio: number;
  readonly distinctColors: number;
  /** Compact fingerprint of 64 points at 4 bits/channel, to judge stability. */
  readonly signature: number[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/** Reads a snapshot of the real 2D VGA canvas, never a fake React screen. */
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
      // 3-bit/channel quantization, like the colorimetry measurement.
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

/** Number of fingerprint points that changed significantly between two polls. */
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

/** Waits for a colored AND stable screen: stability = near-identical consecutive polls. */
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

/** Counts the disk bytes really served over HTTP Range (sum of `Content-Length`). */
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

/** Attaches the raw diagnostics on failure, never a simulated signal. */
async function attachDiagnostics(page: Page, consoleLogs: string[]): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('windows11-v64-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('windows11-console', {
    body: consoleLogs.join('\n') || '(no console message)',
    contentType: 'text/plain',
  });

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'unknown';
  await info.attach('windows11-session-state', {
    body: `data-state=${sessionState}`,
    contentType: 'text/plain',
  });

  const screen = page.locator('.v86-screen');
  if ((await screen.count()) > 0) {
    const shot = await screen.screenshot().catch(() => null);
    if (shot) await info.attach('windows11-vga-canvas', { body: shot, contentType: 'image/png' });
  }
}

/** Windows 11 x64 mother card in the grid, after a "windows" search. */
async function openWindows11Mother(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByLabel('Search for a system').fill('windows');
  return page.locator(`.os-card[data-id="${SYSTEM_SLUG}"]`);
}

test.describe('Windows 11 x64: standalone catalog entry and honest availability', () => {
  test('is standalone and blocks or allows the launch according to the real disk', async ({
    page,
  }) => {
    const card = await openWindows11Mother(page);
    await expect(
      card,
      `System "${SYSTEM_SLUG}" missing from the catalog: no Windows 11 entry to test.`,
    ).toHaveCount(1);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/systems/${SYSTEM_SLUG}$`));

    // Windows 11 x64 is a STANDALONE system: no variant selector.
    await expect(page.getByRole('button', { name: 'Choose variant' })).toHaveCount(0);

    // The launch depends on the real served disk, never on a declared "Available".
    // The profile is now `validated: true` ("Available" card), but the runtime
    // probe (manifest + HTTP Range) still decides.
    const launch = page.getByRole('button', { name: 'Start session' });
    await expect(launch).toBeVisible();
    if (existsSync(DISK_PATH)) {
      await expect(
        launch,
        `${DISK_PATH} exists: "Start session" must be enabled for ${SYSTEM_SLUG}.`,
      ).toBeEnabled();
    } else {
      await expect(
        launch,
        `images/${REF}/disk.img is missing: "Start session" must stay disabled.`,
      ).toBeDisabled();
      await expect(
        page.getByRole('status').filter({ hasText: /disk|media|manifest|missing|unavailable/i }),
        'A disabled launch must explain the missing media instead of failing silently.',
      ).toBeVisible();
    }
  });
});

test.describe('Windows 11 x64: real boot (v64 + OVMF)', () => {
  test.skip(!assetsPresent, 'Local disks missing: set VM_E2E_ASSETS=1.');
  test.skip(
    !win11DiskPresent,
    `Disk "${REF}" missing: provide images/${REF}/manifest.json ` +
      '(boot.mode = disk-boot) and set VM_E2E_ASSETS=1.',
  );

  test('serves the manifest (200 JSON), the disk and the UEFI vars (206 Range), then boots', async ({
    page,
    request,
  }) => {
    test.setTimeout(3_600_000);

    const consoleLogs: string[] = [];
    page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));

    try {
      // 0. Server proofs first: JSON manifest and 206 Range, never a full 200.
      const manifestResponse = await request.get(MANIFEST_URL);
      expect(
        manifestResponse.status(),
        `Manifest ${MANIFEST_URL} not served (HTTP 200 expected).`,
      ).toBe(200);
      expect(manifestResponse.headers()['content-type'] ?? '').toContain('application/json');
      const manifestBody = (await manifestResponse.json()) as {
        ref?: unknown;
        architecture?: unknown;
        memoryMiB?: unknown;
        boot?: { mode?: unknown } | undefined;
        engine?: { id?: unknown } | undefined;
        firmware?: { type?: unknown } | undefined;
      };
      expect(manifestBody.ref).toBe(REF);
      expect(manifestBody.architecture).toBe('x86_64');
      expect(manifestBody.boot?.mode).toBe('disk-boot');
      expect(manifestBody.engine?.id).toBe('v64');
      expect(manifestBody.firmware?.type).toBe('uefi');

      const rangeResponse = await request.get(DISK_URL, {
        headers: { Range: 'bytes=0-511' },
      });
      expect(
        rangeResponse.status(),
        `${DISK_URL} must answer 206 (HTTP Range), never a full 200.`,
      ).toBe(206);
      expect(rangeResponse.headers()['accept-ranges']).toBe('bytes');
      expect(
        rangeResponse.headers()['content-range'],
        'The served disk must announce the expected 64 GiB size.',
      ).toBe(`bytes 0-511/${DISK_SIZE_BYTES}`);
      expect(
        (await rangeResponse.body()).byteLength,
        'The server must return exactly 512 bytes for the requested range.',
      ).toBe(512);

      // OVMF needs its NVRAM store: a missing `uefi-vars.fd` is a hard failure,
      // never a skip (the dev middleware must serve it like the disk).
      const uefiVarsResponse = await request.get(UEFI_VARS_URL, {
        headers: { Range: 'bytes=0-511' },
      });
      expect(
        uefiVarsResponse.status(),
        `${UEFI_VARS_URL} must answer 206 (HTTP Range): OVMF cannot boot without ` +
          'its variables store.',
      ).toBe(206);
      expect(
        (await uefiVarsResponse.body()).byteLength,
        'The server must return exactly 512 bytes of UEFI variables for the requested range.',
      ).toBe(512);

      // 1. UI path: "windows" search -> x64 mother card.
      const card = await openWindows11Mother(page);
      if ((await card.count()) === 0) {
        test.skip(
          true,
          `Card "${SYSTEM_SLUG}" missing: cannot start the session ` +
            '(honest skip, never a success).',
        );
      }
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/systems/${SYSTEM_SLUG}$`));

      // 2. Launch: bundled local disk, no media import.
      const launchButton = page.getByRole('button', { name: 'Start session' });
      await expect(launchButton).toBeEnabled();
      const diskBytes = createDiskByteCounter(page, `/images/${REF}/disk`);
      const bootStartedAt = Date.now();
      await launchButton.click();
      await expect(page).toHaveURL(/\/session\//);
      await expect(page.locator('.session-console')).toBeVisible();

      // 3. `running` follows a real disk read, never a timer: `disk-boot` readiness
      // needs an actual sector served over HTTP Range.
      const state = page.locator('.session-toolbar');
      await expect(state).toHaveAttribute('data-state', 'running', {
        timeout: RUNNING_TIMEOUT_MS,
      });

      // 4. Colored AND stable screen (an animation does not hold stability).
      const proof = await waitForStableColorScreen(page);
      const bootMs = Date.now() - bootStartedAt;

      // 5. Machine proof: the expected disk was really read over HTTP Range.
      const disk = diskBytes();
      expect(
        disk.requests,
        `No HTTP Range request for ${DISK_URL} (expected disk not read).`,
      ).toBeGreaterThan(0);
      expect(disk.bytes, `No disk byte served for ${DISK_URL}.`).toBeGreaterThan(0);

      // Proof captures: VGA screen and logs, for success as well as diagnosis.
      await test.info().attach('windows11-x64-vga-canvas', {
        body: await page.locator('.v86-screen').screenshot(),
        contentType: 'image/png',
      });
      await test.info().attach('windows11-x64-serial', {
        body:
          (await page
            .locator('textarea.v86-serial')
            .inputValue()
            .catch(() => '')) || '(no serial output)',
        contentType: 'text/plain',
      });
      await test.info().attach('windows11-x64-console', {
        body: consoleLogs.join('\n') || '(no console message)',
        contentType: 'text/plain',
      });

      console.log(
        `\n=== Windows 11 x64 (v64 + OVMF, disk-boot) ===\n` +
          `  expected disk              : ${DISK_URL}\n` +
          `  UEFI variables store       : ${UEFI_VARS_URL}\n` +
          `  boot time (click -> screen): ${(bootMs / 1000).toFixed(1)} s\n` +
          `  colored, stable VGA screen : ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
          `nonBlackRatio=${proof.nonBlackRatio?.toFixed(3)} distinctColors=${proof.distinctColors} ` +
          `stablePolls=${proof.stablePolls} (thresholds > ${MIN_NON_BLACK_RATIO} / > ${MIN_DISTINCT_COLORS}, ` +
          `${REQUIRED_STABLE_POLLS} stable polls)\n` +
          `  served disk (Range)        : ${disk.bytes} bytes ` +
          `(${(disk.bytes / 1048576).toFixed(2)} MiB) over ${disk.requests} requests\n` +
          `  guest RAM (manifest)       : ${String(manifestBody.memoryMiB ?? 'unknown')} MiB\n` +
          `  NOTE: colored/stable screen != in-session application proof; ` +
          `the profile is validated for the boot to the logged-in desktop.\n` +
          `=== end measurements ===\n`,
      );

      // Checked last, so a failure still attaches the diagnostics from `catch`.
      expect(
        proof.proven,
        `No colored and stable VGA screen for Windows 11 x64: the canvas ` +
          `.v86-screen-canvas did not hold ${REQUIRED_STABLE_POLLS} stable polls ` +
          `(nonBlackRatio > ${MIN_NON_BLACK_RATIO}, distinctColors > ${MIN_DISTINCT_COLORS}) ` +
          `within ${bootMs} ms. An animated screen (installer/login screen) does NOT ` +
          `count as a desktop.`,
      ).toBe(true);

      // Persistent captures for a human visual check, in addition to the attachments.
      // Paths are anchored on the repository root, never on the current directory.
      const vgaCapturePath = join(REPO_ROOT, 'test-results', 'windows11-vga.png');
      const vgaCapture20sPath = join(REPO_ROOT, 'test-results', 'windows11-vga-20s.png');
      mkdirSync(dirname(vgaCapturePath), { recursive: true });
      await page.locator('.v86-screen').screenshot({ path: vgaCapturePath });
      // Second capture 20 s later, to see the screen evolve (boot/login transitions).
      await page.waitForTimeout(20_000);
      await page.locator('.v86-screen').screenshot({ path: vgaCapture20sPath });

      // 6. Real inputs, then a clean stop.
      const screen = page.locator('.v86-screen');
      await screen.click();
      await page.evaluate(() => document.exitPointerLock()).catch(() => undefined);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
    } catch (error) {
      await attachDiagnostics(page, consoleLogs);
      throw error;
    }
  });
});
