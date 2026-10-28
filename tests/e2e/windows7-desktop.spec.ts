import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * REAL boot of the Windows 7 group in v86, from the local RAW disks
 * `images/windows-7-x86/disk.img` (16 GiB) and
 * `images/windows-7-pro-sp1-x86/disk.img` (32 GiB), outside `public/`.
 *
 * This file is only enabled when the disks are really present and served over
 * HTTP Range:
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm exec playwright test tests/e2e/windows7-desktop.spec.ts
 *
 * Without that variable, the tests are **skipped**, not "passed": without a
 * disk, no proof is possible.
 *
 * Unlike Debian, Windows emits NO LumiBoot marker. The "desktop" proof is
 * therefore **visual**: v86's 2D VGA canvas, the real screen of the emulated
 * machine and never a fake React desktop, must show a colored and stable image,
 * not a black POST screen or a plain text cursor.
 *
 * The path is factored into `bootWindowsDesktop`, which covers navigation,
 * variant selection, launch, wait, visual proof and measurements, and
 * parameterized by the variant label and the URL fragment of the expected disk.
 */

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Software emulation without acceleration: very wide wall-clock budget. */
const RUNNING_TIMEOUT_MS = 900_000;
const DESKTOP_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 60_000;

/**
 * A "desktop" is accepted when, on **3 consecutive polls**, the canvas is
 * visible, mostly non-black with `nonBlackRatio > 0.5`, and colorful enough with
 * `distinctColors > 64`, colors quantized to 3 bits/channel.
 *
 * The poll counter lives on `window` because `waitForFunction` re-evaluates the
 * function on every poll without keeping closure state.
 */
export interface DesktopMetrics {
  /** True when the desktop was proven over `consecutive` polls. */
  readonly proven: boolean;
  /** Measurements of the last conclusive poll, null when not proven. */
  readonly nonBlackRatio: number | null;
  readonly distinctColors: number | null;
  /** Native canvas resolution at the time of the proof. */
  readonly canvasWidth: number | null;
  readonly canvasHeight: number | null;
}

async function waitForDesktopProof(page: Page): Promise<DesktopMetrics> {
  try {
    const handle = await page.waitForFunction(
      ({ minNonBlackRatio, minDistinctColors, consecutive, stride }) => {
        const state = window as unknown as { __lumibootWin7Polls?: number };
        // `null` = "not yet": keep polling.
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
          // 3-bit/channel quantization: the 3 least significant bits are merged.
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
        // A desktop is only accepted after `consecutive` positive polls in a row.
        if (state.__lumibootWin7Polls >= consecutive) {
          // Measurements of the conclusive poll, with the same thresholds and no
          // relaxation.
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
 * Counter of the disk bytes really served over HTTP Range for the expected disk,
 * `diskUrlFragment`.
 *
 * `performance.transferSize` heavily UNDER-COUNTS the range XHRs of v86,
 * observed at ~97 KiB reported for ~193 MiB actually served. The real HTTP
 * responses, captured with `page.on('response')`, are therefore counted, with the
 * sum of their `Content-Length`, which reflects the effective Range traffic.
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

/** JS bytes really used, a non-standard best-effort figure. */
async function heapUsedBytes(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number };
    };
    return perf.memory?.usedJSHeapSize ?? null;
  });
}

/** Attaches the raw diagnostics on failure, never a simulated signal. */
async function attachDiagnostics(page: Page, consoleLogs: string[]): Promise<void> {
  const info = test.info();

  const serial =
    (await page
      .locator('textarea.v86-serial')
      .inputValue()
      .catch(() => '')) || '';
  await info.attach('v86-serial', { body: serial, contentType: 'text/plain' });

  await info.attach('console', {
    body: consoleLogs.join('\n') || '(no console message)',
    contentType: 'text/plain',
  });

  const sessionState =
    (await page
      .locator('.session-toolbar')
      .getAttribute('data-state')
      .catch(() => null)) ?? 'unknown';
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
  /** Exact label of the variant to select; absent means the default variant. */
  readonly variantLabel?: string;
  /** URL fragment of the disk expected for this boot. */
  readonly diskUrlFragment: string;
  /** Name of the attached VGA screenshot, the visual proof. */
  readonly screenshotName: string;
  /** Title printed in the measurements. */
  readonly title: string;
  /** Guest RAM requested from the engine, as declared in the catalog profile. */
  readonly guestRamMiB: number;
}

export interface WindowsBootResult {
  readonly bootMs: number;
  readonly disk: { bytes: number; requests: number };
  readonly heap: number | null;
  readonly state: Locator;
}

/**
 * Complete and proven path of a Windows 7 variant: library -> "windows" search
 * -> `windows-7-x86` mother card -> optional variant selection -> launch ->
 * `running` -> visual desktop proof on the real 2D VGA canvas -> measurements:
 * time, disk bytes through HTTP responses, memory. On failure, the raw
 * diagnostics are attached.
 */
async function bootWindowsDesktop(
  page: Page,
  options: WindowsBootOptions,
): Promise<WindowsBootResult> {
  const consoleLogs: string[] = [];
  page.on('console', (message) => consoleLogs.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => consoleLogs.push(`[pageerror] ${error.message}`));
  // Registered BEFORE the launch click to count every disk Range.
  const diskBytes = createDiskByteCounter(page, options.diskUrlFragment);

  try {
    // 1. Path: library -> "windows" search -> mother card.
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('windows');
    await page.locator('.os-card[data-id="windows-7-x86"]').click();
    await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);

    // 2. Optional variant selection through the custom dropdown: it does NOT
    //    navigate, so the mother page stays displayed.
    if (options.variantLabel) {
      await page.getByRole('button', { name: 'Choose variant' }).click();
      await page.getByRole('button', { name: options.variantLabel, exact: true }).click();
      await expect(page).toHaveURL(/\/systems\/windows-7-x86$/);
    }

    // 3. Launch: no media import, bundled disk of the codebase.
    const launchButton = page.getByRole('button', { name: 'Start session' });
    await expect(launchButton).toBeEnabled();
    const bootStartedAt = Date.now();
    await launchButton.click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(page.locator('.session-console')).toBeVisible();

    // 4. `running` is only emitted after a real disk read, `ide-read-end`, never
    //    simulated by a React timer.
    const state = page.locator('.session-toolbar');
    await expect(state).toHaveAttribute('data-state', 'running', {
      timeout: RUNNING_TIMEOUT_MS,
    });

    // 5. Visual proof: the 2D VGA canvas shows a colored and stable desktop.
    const proof = await waitForDesktopProof(page);
    const bootMs = Date.now() - bootStartedAt;
    // On failure, the `catch` below attaches the raw diagnostics.
    expect(
      proof.proven,
      `No VGA desktop proven for "${options.title}": the canvas ` +
        `.v86-screen-canvas did not reach nonBlackRatio > 0.5 / distinctColors > 64 ` +
        `over 3 consecutive polls (elapsed: ${bootMs} ms).`,
    ).toBe(true);

    // Screenshot of the real v86 screen, the 2D canvas, never a fake React desktop.
    await test.info().attach(options.screenshotName, {
      body: await page.locator('.v86-screen').screenshot(),
      contentType: 'image/png',
    });

    // 6. Measurements: boot time, disk bytes really served, memory.
    const disk = diskBytes();
    const heap = await heapUsedBytes(page);
    // The expected disk MUST have been really served over HTTP Range.
    expect(
      disk.requests,
      `No HTTP Range request for "${options.diskUrlFragment}" ` + `(expected disk not served).`,
    ).toBeGreaterThan(0);
    console.log(
      `\n=== ${options.title} ===\n` +
        `  expected disk          : ${options.diskUrlFragment}\n` +
        `  boot time (click -> desktop): ${(bootMs / 1000).toFixed(1)} s\n` +
        `  VGA desktop (2D canvas): ${proof.canvasWidth}x${proof.canvasHeight}px, ` +
        `nonBlackRatio=${proof.nonBlackRatio?.toFixed(3)} distinctColors=${proof.distinctColors} ` +
        `(thresholds > 0.5 / > 64 over 3 polls)\n` +
        `  served disk (Range)    : ${disk.bytes} bytes ` +
        `(${(disk.bytes / 1048576).toFixed(2)} MiB) over ${disk.requests} requests\n` +
        `  JS heap used           : ${heap === null ? 'unavailable' : `${heap} bytes`}\n` +
        `  guest RAM              : ${options.guestRamMiB} MiB\n` +
        `=== end measurements ===\n`,
    );

    return { bootMs, disk, heap, state };
  } catch (error) {
    await attachDiagnostics(page, consoleLogs);
    throw error;
  }
}

/**
 * Common post-boot steps: real inputs, since mouse and keyboard reach the
 * emulated screen; Pointer Lock capture with a single cursor, the guest one;
 * fullscreen available, then a clean stop.
 */
async function exerciseAndStop(page: Page, state: Locator): Promise<void> {
  const screen = page.locator('.v86-screen');

  // An explicit click inside the screen captures the pointer: the browser hides
  // the host cursor and v86 receives RELATIVE movements, even at the edges.
  await screen.click();
  await expect
    .poll(() =>
      page.evaluate(() => document.pointerLockElement?.classList.contains('v86-screen') ?? false),
    )
    .toBe(true);

  // Escape is handled natively by the browser; in headless Chromium it is not
  // intercepted, so the lock is released explicitly, following the same
  // `pointerlockchange` path as the one triggered by Escape in a real session.
  await page.evaluate(() => document.exitPointerLock());
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
}

test.describe('Windows 7 session (v86, real boot)', () => {
  test.skip(!assetsPresent, 'Windows 7 disks missing: set VM_E2E_ASSETS=1.');

  test('boots the default variant (Professional) from the 32 GiB RAW disk and stops', async ({
    page,
  }) => {
    // Complete Windows boot under software emulation: explicit wall-clock budget.
    test.setTimeout(1_800_000);

    // No variant selected: the mother opens the best variant, Professional, with
    // `variantOrder: 1`.
    const { state } = await bootWindowsDesktop(page, {
      diskUrlFragment: '/images/windows-7-pro-sp1-x86/disk.img',
      screenshotName: 'windows7-professionnel-desktop',
      title: 'Windows 7 Professional SP1 x86',
      guestRamMiB: 1536,
    });

    await exerciseAndStop(page, state);
  });

  test('switches to the Lite variant and boots the 16 GiB RAW disk', async ({ page }) => {
    test.setTimeout(1_800_000);

    // "Lite" is explicitly selected in the dropdown, then launched.
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
