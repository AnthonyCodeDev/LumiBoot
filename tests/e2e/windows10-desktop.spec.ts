import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Windows 10 x86 under v86 - standalone system and real boot (local disk).
 *
 * This file covers two levels, deliberately separated:
 *
 * 1. **Without a disk** (always run): Windows 10 x86 is a STANDALONE system (no
 *    variant selector), validated and therefore advertised as `Available`; the
 *    launch is honestly blocked when the disk is not served (404 manifest). No
 *    fake `ready`, no fake `passed`.
 *
 * 2. **With a real disk** (opt-in): only if `VM_E2E_ASSETS=1` AND
 *    an x86 Windows 10 disk is present (`WIN10_DISK` variable or
 *    `images/windows-10-x86/manifest.json` with `boot.mode === 'disk-boot'`).
 *    The test checks the JSON HTTP 200 manifest, the disk over HTTP Range 206,
 *    starts a REAL session (`data-state=running`, emitted after a disk read
 *    `ide-read-end`) and captures the VGA screen + the logs. Without either
 *    guardrail, the test is **skipped** (never "passed").
 *
 * Windows 10 x86 is validated, like Windows 7: same local disk pipeline under
 * v86. The "no disk" case (404 manifest) still blocks the launch. This file
 * NEVER presents the colored VGA screen as a guaranteed desktop proof. The
 * Windows 7 path (`windows7-desktop.spec.ts`) stays unchanged and is the
 * reference for Windows 7.
 *
 * Real boot command:
 *
 *   $env:VM_E2E_ASSETS='1'; $env:WIN10_DISK='1'; pnpm exec playwright test tests/e2e/windows10-desktop.spec.ts
 */

// ---------------------------------------------------------------------------
// Execution guardrails (real disk present or not)
// ---------------------------------------------------------------------------

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** True when an environment variable is "enabled" (non-empty, not 0/false). */
function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/** Walks up the tree to the repository root (pnpm-workspace marker). */
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
const WIN10_MANIFEST_URL = `/images/${WIN10_REF}/manifest.json`;
const WIN10_DISK_URL = process.env.WIN10_DISK_URL?.trim() || `/images/${WIN10_REF}/disk.img`;

interface PrivateDiskManifest {
  readonly boot?: { readonly mode?: unknown } | undefined;
}

/**
 * Detects an x86 Windows 10 disk present on the machine: either `WIN10_DISK` is
 * enabled, or a `disk-boot` manifest exists under `images/windows-10-x86/`. This
 * is a prerequisite of the real boot: without it, no boot test runs (explicit
 * skip, never a success).
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
// Time budgets (software emulation: very wide)
// ---------------------------------------------------------------------------

const RUNNING_TIMEOUT_MS = 900_000;
const SCREEN_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 60_000;

// Thresholds of the visual signal. They are NOT a desktop proof: they complement
// the machine proof (real disk read) with a colored AND stable screen. An
// installer or an animated login screen does not hold the required stability, and
// is therefore never counted as a desktop.
const MIN_NON_BLACK_RATIO = 0.3;
const MIN_DISTINCT_COLORS = 32;
const REQUIRED_STABLE_POLLS = 4;
const POLL_INTERVAL_MS = 1_500;
/** Fingerprint points that may change without breaking stability (noise/cursor). */
const MAX_CHANGED_SAMPLES = 6;

interface CanvasSample {
  readonly nonBlackRatio: number;
  readonly distinctColors: number;
  /** Compact fingerprint (64 points, 4 bits/channel) to judge stability. */
  readonly signature: number[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

/** Reads a snapshot of the real 2D VGA canvas (never a fake React screen). */
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
      // 3-bit/channel quantization (like the colorimetry measurement).
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

/**
 * Waits for a colored AND STABLE VGA screen. Stability (several consecutive
 * nearly identical polls) is what distinguishes a settled screen from an
 * installer animation or an animated login screen. It stays a visual signal,
 * never a "desktop" guarantee: the machine proof is the real disk read
 * (`running` in `disk-boot` + HTTP Range requests).
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
 * Counter of the disk bytes really served over HTTP Range. The real HTTP
 * responses (`page.on('response')`) are counted with the sum of their
 * `Content-Length`, because `performance.transferSize` heavily under-counts the
 * range XHRs of v86.
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

/** JS bytes really used (non-standard, best-effort). */
async function heapUsedBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? null;
  });
}

/** Attaches the raw diagnostics on failure (never a simulated signal). */
async function attachDiagnostics(page: Page, consoleLogs: string[]): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('windows10-v86-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('windows10-console', {
    body: consoleLogs.join('\n') || '(no console message)',
    contentType: 'text/plain',
  });

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'unknown';
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

/** Windows 10 mother card in the grid, after a "windows" search. */
async function openWindows10Mother(page: Page): Promise<Locator> {
  await page.goto('/');
  await page.getByLabel('Search for a system').fill('windows');
  return page.locator(`.os-card[data-id="${WIN10_SYSTEM_SLUG}"]`);
}

// ---------------------------------------------------------------------------
// 1. Standalone system, without a disk - always run
// ---------------------------------------------------------------------------

test.describe('Windows 10 x86: standalone system and availability (without a disk)', () => {
  test('is standalone, available, and honestly blocks the launch without a disk', async ({
    page,
  }) => {
    // Forces the absence of the disk, even if the operator has one locally: the
    // tested case is "no fake availability without served media".
    await page.route(new RegExp(`/images/${WIN10_REF}/manifest\\.json(?:\\?.*)?$`), (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

    const card = await openWindows10Mother(page);
    if ((await card.count()) === 0) {
      test.skip(
        true,
        `System "${WIN10_SYSTEM_SLUG}" missing from the catalog: no proof possible ` +
          '(honest skip, never a success).',
      );
    }
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/systems/${WIN10_SYSTEM_SLUG}$`));

    // 1. Windows 10 x86 is a STANDALONE system: no variant selector.
    await expect(page.getByRole('button', { name: 'Choose variant' })).toHaveCount(0);

    // 2. The system is validated (same pipeline as Windows 7): it is advertised
    //    as "Available" like Windows 7.
    const stateValue = page
      .locator('.spec-box > div')
      .filter({ hasText: 'Status' })
      .locator('strong');
    await expect(stateValue).toBeVisible();
    await expect(stateValue).toHaveText('Available');

    // 3. Without a served disk (404 manifest), the launch is blocked with an
    //    explicit reason: no fake availability.
    const launch = page.getByRole('button', { name: 'Start session' });
    await expect(launch).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: /manifest.*missing|manifest.*unavailable/i }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2. Real boot - opt-in (disk present)
// ---------------------------------------------------------------------------

test.describe('Windows 10 x86: real boot (v86)', () => {
  test.skip(!assetsPresent, 'Local disks missing: set VM_E2E_ASSETS=1.');
  test.skip(
    !win10DiskPresent,
    `Disk "${WIN10_REF}" missing: set WIN10_DISK=1 or provide ` +
      `images/${WIN10_REF}/manifest.json (boot.mode = disk-boot).`,
  );

  test('serves the manifest (200 JSON) and the disk (206 Range), then starts a real session', async ({
    page,
    request,
  }) => {
    test.setTimeout(1_800_000);

    const consoleLogs: string[] = [];
    page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));

    try {
      // 0. Server proofs BEFORE any UI: valid JSON manifest + disk served over
      //    HTTP Range (206), never a full 200 that v86 could not read.
      const manifestResponse = await request.get(WIN10_MANIFEST_URL);
      expect(
        manifestResponse.status(),
        `Manifest ${WIN10_MANIFEST_URL} not served (HTTP 200 expected).`,
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
        `${WIN10_DISK_URL} must answer 206 (HTTP Range), never a full 200.`,
      ).toBe(206);
      expect(rangeResponse.headers()['accept-ranges']).toBe('bytes');
      expect(rangeResponse.headers()['content-range'] ?? '').toMatch(/^bytes 0-511\//);
      expect(
        (await rangeResponse.body()).byteLength,
        'The server must return exactly 512 bytes for the requested range.',
      ).toBe(512);

      // 1. UI path: "windows" search -> x86 mother card.
      const card = await openWindows10Mother(page);
      if ((await card.count()) === 0) {
        test.skip(
          true,
          `Card "${WIN10_SYSTEM_SLUG}" missing: cannot start the session ` +
            '(honest skip, never a success).',
        );
      }
      await card.click();
      await expect(page).toHaveURL(new RegExp(`/systems/${WIN10_SYSTEM_SLUG}$`));

      // 2. Launch: bundled local disk, no media import.
      const launchButton = page.getByRole('button', { name: 'Start session' });
      await expect(launchButton).toBeEnabled();
      const diskBytes = createDiskByteCounter(page, `/images/${WIN10_REF}/disk`);
      const bootStartedAt = Date.now();
      await launchButton.click();
      await expect(page).toHaveURL(/\/session\//);
      await expect(page.locator('.session-console')).toBeVisible();

      // 3. `running` in `disk-boot` is only emitted after a REAL disk read
      //    (`ide-read-end`), never simulated by a React timer.
      const state = page.locator('.session-toolbar');
      await expect(state).toHaveAttribute('data-state', 'running', {
        timeout: RUNNING_TIMEOUT_MS,
      });

      // 4. Strengthened visual signal: colored AND STABLE screen (an installer
      //    animation or an animated login screen does not hold stability).
      const proof = await waitForStableColorScreen(page);
      const bootMs = Date.now() - bootStartedAt;

      // 5. Machine proof: the expected disk was really read over HTTP Range.
      const disk = diskBytes();
      const heap = await heapUsedBytes(page);
      expect(
        disk.requests,
        `No HTTP Range request for ${WIN10_DISK_URL} (expected disk not read).`,
      ).toBeGreaterThan(0);

      // Proof captures (real VGA screen + logs), for success as well as diagnosis.
      await test.info().attach('windows10-x86-vga-canvas', {
        body: await page.locator('.v86-screen').screenshot(),
        contentType: 'image/png',
      });
      await test.info().attach('windows10-x86-serial', {
        body:
          (await page
            .locator('textarea.v86-serial')
            .inputValue()
            .catch(() => '')) || '(no serial output)',
        contentType: 'text/plain',
      });
      await test.info().attach('windows10-x86-console', {
        body: consoleLogs.join('\n') || '(no console message)',
        contentType: 'text/plain',
      });

      console.log(
        `\n=== Windows 10 x86 (validated) ===\n` +
          `  expected disk              : ${WIN10_DISK_URL}\n` +
          `  boot time (click -> screen): ${(bootMs / 1000).toFixed(1)} s\n` +
          `  colored, stable VGA screen : ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
          `nonBlackRatio=${proof.nonBlackRatio?.toFixed(3)} distinctColors=${proof.distinctColors} ` +
          `stablePolls=${proof.stablePolls} (thresholds > ${MIN_NON_BLACK_RATIO} / > ${MIN_DISTINCT_COLORS}, ` +
          `${REQUIRED_STABLE_POLLS} stable polls)\n` +
          `  served disk (Range)        : ${disk.bytes} bytes ` +
          `(${(disk.bytes / 1048576).toFixed(2)} MiB) over ${disk.requests} requests\n` +
          `  JS heap used               : ${heap === null ? 'unavailable' : `${heap} bytes`}\n` +
          `  guest RAM                  : 2048 MiB\n` +
          `  NOTE: colored/stable screen != guaranteed desktop proof; ` +
          `validated profile (same pipeline as Windows 7).\n` +
          `=== end measurements ===\n`,
      );

      // The visual signal is checked AFTER the measurements so the raw
      // diagnostics (catch) are attached on failure, without hiding the real
      // cause.
      expect(
        proof.proven,
        `No colored and stable VGA screen for Windows 10 x86: the canvas ` +
          `.v86-screen-canvas did not hold ${REQUIRED_STABLE_POLLS} stable polls ` +
          `(nonBlackRatio > ${MIN_NON_BLACK_RATIO}, distinctColors > ${MIN_DISTINCT_COLORS}) ` +
          `within ${bootMs} ms. An animated screen (installer/login screen) does NOT ` +
          `count as a desktop.`,
      ).toBe(true);

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
