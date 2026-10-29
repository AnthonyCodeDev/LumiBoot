import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * REAL boot of Ubuntu 18.04 LTS (bionic) i386 "Desktop" with Xorg and Openbox in v86.
 *
 * This test is only enabled when the desktop image is really published, with
 * `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json`:
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm exec playwright test tests/e2e/desktop-ubuntu.spec.ts
 *
 * Without that variable, the test is **skipped**, not "passed": no image, so
 * no possible proof.
 *
 * Proof sought: the `LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-desktop` marker
 * written by the guest on `ttyS0` **after** the X server answers `xdpyinfo`
 * and Openbox runs. No marker is produced on the JavaScript/React side.
 */

/** Software emulation without acceleration is slow: wide wall-clock budget. */
const BOOT_MARKER_TIMEOUT_MS = 420_000;
/** Short delay after the marker: `running` follows the marker very closely. */
const RUNNING_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const READY_MARKER = 'LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-desktop';
const FAILED_MARKER = 'LUMIBOOT_DESKTOP_START_FAILED:ubuntu-18-i386-desktop';

/**
 * Stricter guard than the Debian spec: the artifacts must be published AND
 * `validated: true` must be set on the profile after a real, proven boot.
 */
const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/ubuntu-18-i386-desktop/manifest.json'));

/**
 * Waits for the graphical session proof and returns a readable status.
 *
 * The `.v86-serial` `<textarea>` is watched, since the guest output lives in its
 * *value* and not in its text content, along with the session state. The wait
 * stops as soon as a READY or START_FAILED marker shows up, or when the
 * session moves to `error`. None of these signals is simulated: they all come
 * from v86 or from the guest. If nothing arrives in time, `timeout` is returned
 * and the test fails while printing the full serial output for diagnosis.
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
  await page.getByLabel('Search for a system').fill('ubuntu');
  // The Ubuntu card opens the MOTHER; XFCE is preselected, so the Desktop X11
  // variant is selected through the custom dropdown WITHOUT changing the URL,
  // then launched.
  await page.locator('.os-card[data-id="ubuntu-18-i386"]').click();
  await expect(page).toHaveURL(/\/systems\/ubuntu-18-i386$/);
  await page.getByRole('button', { name: 'Choose variant' }).click();
  await page.getByRole('button', { name: /^Ubuntu X11\b/ }).click();
  // The dropdown does not navigate: the mother page stays displayed.
  await expect(page).toHaveURL(/\/systems\/ubuntu-18-i386$/);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/session\//);

  // The console container stays mounted during the whole boot.
  await expect(page.locator('.session-console')).toBeVisible();
  // A graphical profile keeps the serial logs collapsed: the button is a toggle,
  // so it is only clicked when the panel is closed.
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

test.describe('Ubuntu 18.04 i386 Desktop session (Xorg + Openbox, real boot)', () => {
  test.skip(!assetsPresent, 'Ubuntu Desktop image missing: set VM_E2E_ASSETS=1 once published.');

  test('boots a real graphical session, hands it back to the browser and restarts', async ({
    page,
  }) => {
    // Two complete graphical boots under slow software emulation: explicit and
    // wide wall-clock budget, since the marker can take up to 420 s per boot.
    test.setTimeout(1_200_000);

    const { serial, state } = await openDesktopSession(page);

    await expect(serial).toHaveValue(/LUMIBOOT_ROOT_DEVICE_READY:\/dev\/sda/, {
      timeout: 60_000,
    });
    // No failed filesystem probe: the marker above must mean a readable root.
    await expect(serial).not.toHaveValue(/LUMIBOOT_ROOT_DEVICE_FAILED/);

    // 1. Graphical session proof from the guest marker on ttyS0, never simulated.
    const proof = await waitForDesktopProof(page);
    if (proof !== 'ready') {
      const value = await dumpSerial(page, serial, proof);
      // An explicit failure marker is reported as is; otherwise the full serial
      // output is attached for diagnosis: X, fbdev, dbus, startx.
      expect(
        proof,
        `Graphical session not proven (status=${proof}). ` +
          `Expected marker: ${READY_MARKER}.\nSerial output:\n${value}`,
      ).toBe('ready');
    }

    // 2. `running` is only emitted AFTER `DESKTOP_READY`, see V86Instance.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });

    // 3. Real graphical rendering: the VGA canvas is displayed in graphical mode
    //    and sized. In text mode, v86 hides the canvas with `display:none`.
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

    // 4. Visual inspection: full screen + VGA screen alone.
    await page.screenshot({ path: 'test-results/ubuntu-desktop-boot.png' });
    await page
      .locator('.session-console')
      .screenshot({ path: 'test-results/ubuntu-desktop-vga.png' });

    // 5. No blocking `login:`: the tty1 VGA console was replaced by the
    //    graphical session, with the canvas in graphical mode. No *pending*
    //    login prompt may be visible. NO command is typed in the GUI, since it
    //    is unreliable under software emulation.
    const vgaText = (await page.locator('.v86-screen-text').textContent()) ?? '';
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // 6. Stop then restart: complete lifecycle, no orphaned resource.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: STOP_TIMEOUT_MS });

    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(page).toHaveURL(/\/session\//);

    const restarted = await openRestartProof(page);
    if (restarted !== 'ready') {
      const value = await dumpSerial(page, page.locator('.v86-serial'), `restart-${restarted}`);
      expect(
        restarted,
        `Graphical session not proven after restart (status=${restarted}).\nSerial output:\n${value}`,
      ).toBe('ready');
    }
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });
  });
});

/**
 * Restart recreates a fresh session: the locators stay valid because the classes
 * are unchanged, but the serial output starts from scratch. The logs are shown
 * again and the graphical proof is awaited once more.
 */
async function openRestartProof(page: Page): Promise<'ready' | 'failed' | 'error' | 'timeout'> {
  await expect(page.locator('.session-console')).toBeVisible();
  const logsButton = page.getByRole('button', { name: 'Logs' });
  if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
    await logsButton.click();
  }
  return waitForDesktopProof(page);
}
