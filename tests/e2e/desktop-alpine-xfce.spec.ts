import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

// Real Alpine Linux 3.24 x86-64 XFCE boot on the v64 engine (Xorg + XFCE on the
// VGA screen); skipped without VM_E2E_ASSETS=1 and the published ISO. The guest
// boots a preinstalled squashfs rootfs through overlayfs, so there is no apk
// installation to wait for.

/** XFCE under a 64-bit software JIT: the widest budget of the desktop specs. */
const BOOT_MARKER_TIMEOUT_MS = 900_000;
/** Short delay after the marker: `running` follows the marker very closely. */
const RUNNING_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
/**
 * The marker only proves X and the XFCE processes run; xfdesktop paints the
 * root window later, and the squashfs rootfs is read from the emulated CD, so
 * the canvas stays legitimately black in between.
 */
const DESKTOP_PAINT_TIMEOUT_MS = 300_000;
/** Three consecutive measurements: a desktop is drawn, not a transient frame. */
const CANVAS_SAMPLES = 3;
const CANVAS_SAMPLE_DELAY_MS = 5_000;

const READY_MARKER = 'LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce';
const FAILED_MARKER = 'LUMIBOOT_DESKTOP_START_FAILED:alpine-3-24-x86-64-xfce';

// Stricter guard: the artifacts must be published for the profile to be shown.
const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/alpine-3-24-x86-64-xfce/manifest.json')) &&
  existsSync(join(process.cwd(), 'apps/web/public/v64/v86.wasm'));

/** A drawn desktop is neither a black screen nor a single flat colour. */
const MIN_MEAN_LUMA = 12;
const MIN_NON_BLACK_RATIO = 0.15;
const MIN_DISTINCT_COLORS = 8;

interface CanvasMeasurement {
  width: number;
  height: number;
  meanLuma: number;
  nonBlackRatio: number;
  distinctColors: number;
}

/** Waits for the guest READY/FAILED marker or an `error` state, else `timeout`. */
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

async function openXfceSession(page: Page): Promise<{ serial: Locator; state: Locator }> {
  await page.goto('/systems/alpine-3-24-x86-64-xfce');
  // v64 needs SharedArrayBuffer for its parallel vCPUs: a missing isolation is
  // a hosting error, not a guest failure.
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/session\//);

  // The console container stays mounted during the whole boot.
  await expect(page.locator('.session-console')).toBeVisible();
  // Serial logs are hidden by default: show them to read `.v86-serial`.
  const logsButton = page.getByRole('button', { name: 'Logs' });
  if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
    await logsButton.click();
  }

  return { serial: page.locator('.v86-serial'), state: page.locator('.session-toolbar') };
}

/** Dumps the full serial output into the test output for diagnosis. */
async function dumpSerial(page: Page, serial: Locator, reason: string): Promise<string> {
  const value = (await serial.inputValue().catch(() => '')) || '';
  console.log(`\n=== FULL SERIAL OUTPUT (${reason}) ===\n${value}\n=== END SERIAL OUTPUT ===\n`);
  await test.info().attach(`serial-${reason}`, { body: value, contentType: 'text/plain' });
  return value;
}

/**
 * Measures the VGA canvas through a screenshot: it works whatever backend v64
 * selected (2D, WebGL, WebGPU) and only ever looks at what the visitor sees.
 */
async function measureCanvas(page: Page): Promise<CanvasMeasurement> {
  const canvas = page.locator('.v86-screen-canvas');
  const geometry = await canvas.evaluate((element) => {
    const node = element as HTMLCanvasElement;
    return { width: node.width, height: node.height };
  });
  let png: string;
  try {
    png = (await canvas.screenshot()).toString('base64');
  } catch {
    // Hidden canvas (text mode) is not a failure: it is just not painted yet.
    return { ...geometry, meanLuma: 0, nonBlackRatio: 0, distinctColors: 0 };
  }
  const stats = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const surface = document.createElement('canvas');
    surface.width = image.width;
    surface.height = image.height;
    const context = surface.getContext('2d');
    if (!context) throw new Error('A 2D context is required to measure the canvas.');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, surface.width, surface.height);
    const total = surface.width * surface.height;
    const step = Math.max(1, Math.floor(total / 20_000));
    const colors = new Set<number>();
    let lumaSum = 0;
    let nonBlack = 0;
    let count = 0;
    for (let pixel = 0; pixel < total; pixel += step) {
      const offset = pixel * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      if (luma > 8) nonBlack += 1;
      if (colors.size < 512) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      count += 1;
    }
    return {
      meanLuma: count > 0 ? lumaSum / count : 0,
      nonBlackRatio: count > 0 ? nonBlack / count : 0,
      distinctColors: colors.size,
    };
  }, png);
  return { ...geometry, ...stats };
}

test.describe('Alpine Linux 3.24 x86-64 XFCE session (Xorg + XFCE, real boot)', () => {
  test.skip(!assetsPresent, 'Alpine XFCE image missing: set VM_E2E_ASSETS=1 once published.');

  test('boots a real XFCE session and draws it on the VGA canvas', async ({ page }) => {
    // One XFCE boot under a 64-bit software JIT: explicit 20 min budget
    // (no apk install, the squashfs rootfs is mounted in seconds).
    test.setTimeout(1_200_000);
    const startedAt = Date.now();

    const { serial, state } = await openXfceSession(page);

    // 1. Graphical session proof from the guest marker on ttyS0, never simulated.
    const proof = await waitForDesktopProof(page);
    if (proof !== 'ready') {
      const value = await dumpSerial(page, serial, proof);
      // Serial output is attached for diagnosis (X, modesetting, dbus, startx).
      expect(
        proof,
        `Graphical session not proven (status=${proof}). ` +
          `Expected marker: ${READY_MARKER}.\nSerial output:\n${value}`,
      ).toBe('ready');
    }
    // The proof is recorded in the test output: the marker, its delay and the
    // serial tail around it are what the documentation quotes.
    const markerDelaySeconds = (Date.now() - startedAt) / 1000;
    const serialTail = (await serial.inputValue()).split(/\r?\n/).slice(-40).join('\n');
    console.log(
      `\n[alpine-xfce] ${READY_MARKER} after ${markerDelaySeconds.toFixed(1)} s\n` +
        `=== SERIAL TAIL ===\n${serialTail}\n=== END SERIAL TAIL ===\n`,
    );

    // 2. `running` is only emitted AFTER `DESKTOP_READY`, see V86Instance.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });

    // 3. The canvas is displayed and sized in graphical mode (hidden in text mode).
    const screen = page.locator('.v86-screen');
    const canvas = page.locator('.v86-screen-canvas');
    await expect(screen).toBeVisible();
    await expect(canvas).toBeVisible({ timeout: DEFAULT_PROBE_TIMEOUT_MS });

    // 4. Pixels, not only a mode: a mode switch alone leaves a black canvas.
    //    The desktop is painted well after the marker, so wait for it.
    await expect
      .poll(async () => (await measureCanvas(page)).meanLuma, {
        timeout: DESKTOP_PAINT_TIMEOUT_MS,
        intervals: [10_000],
        message: 'The XFCE desktop never reached the VGA canvas after the marker.',
      })
      .toBeGreaterThan(MIN_MEAN_LUMA);

    const dims = await canvas.evaluate((element) => {
      const node = element as HTMLCanvasElement;
      return { width: node.width, height: node.height };
    });
    expect(dims.width).toBeGreaterThanOrEqual(800);
    expect(dims.height).toBeGreaterThanOrEqual(600);
    // 4:3, like the X session the guest sets up: not a stretched text framebuffer.
    expect(dims.width / dims.height).toBeGreaterThan(1.2);
    expect(dims.width / dims.height).toBeLessThan(1.7);

    // 5. Three consecutive samples: a readable, stable desktop.
    let lastMeasurement = await measureCanvas(page);
    for (let sample = 0; sample < CANVAS_SAMPLES; sample += 1) {
      if (sample > 0) await page.waitForTimeout(CANVAS_SAMPLE_DELAY_MS);
      const measurement = await measureCanvas(page);
      lastMeasurement = measurement;
      expect(
        measurement.meanLuma,
        `The XFCE desktop is not drawn (sample ${sample + 1}): ` +
          `meanLuma=${measurement.meanLuma.toFixed(2)}, ` +
          `nonBlackRatio=${measurement.nonBlackRatio.toFixed(3)}, ` +
          `distinctColors=${measurement.distinctColors}.`,
      ).toBeGreaterThan(MIN_MEAN_LUMA);
      expect(measurement.nonBlackRatio).toBeGreaterThan(MIN_NON_BLACK_RATIO);
      expect(measurement.distinctColors).toBeGreaterThanOrEqual(MIN_DISTINCT_COLORS);
    }
    console.log(
      `[alpine-xfce] canvas ${dims.width}x${dims.height}: ` +
        `meanLuma=${lastMeasurement.meanLuma.toFixed(1)}, ` +
        `nonBlackRatio=${lastMeasurement.nonBlackRatio.toFixed(3)}, ` +
        `distinctColors=${lastMeasurement.distinctColors}`,
    );

    // 6. Visual inspection: full screen + VGA screen alone.
    await page.screenshot({ path: 'test-results/alpine-xfce-boot.png' });
    await page.locator('.session-console').screenshot({ path: 'test-results/alpine-xfce-vga.png' });

    // 7. No pending `login:` prompt; no command is typed in the GUI.
    const vgaText = (await page.locator('.v86-screen-text').textContent()) ?? '';
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // 8. Stop: complete lifecycle, no orphaned resource.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });
  });
});
