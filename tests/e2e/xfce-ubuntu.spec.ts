import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

// Real Ubuntu 18.04 i386 XFCE boot (Xorg + XFCE); skipped without VM_E2E_ASSETS=1.

// XFCE is heavier than Openbox: it needs a wider budget than the desktop flavor.
const BOOT_MARKER_TIMEOUT_MS = 600_000;
/** Short delay after the marker: `running` follows the marker very closely. */
const RUNNING_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const READY_MARKER = 'LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-xfce';
const FAILED_MARKER = 'LUMIBOOT_DESKTOP_START_FAILED:ubuntu-18-i386-xfce';

// Stricter guard: the artifacts must be published for the profile to be shown.
const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/ubuntu-18-i386-xfce/manifest.json'));

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
  await page.goto('/');
  await page.getByLabel('Search for a system').fill('ubuntu');
  // The mother opens with XFCE, but it is selected explicitly to prove the profile.
  await page.locator('.os-card[data-id="ubuntu-18-i386"]').click();
  await expect(page).toHaveURL(/\/systems\/ubuntu-18-i386$/);
  await page.getByRole('button', { name: 'Choose variant' }).click();
  await page.getByRole('button', { name: /^Ubuntu XFCE\b/ }).click();
  await expect(page).toHaveURL(/\/systems\/ubuntu-18-i386$/);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/session\//);

  // The console container stays mounted during the whole boot.
  await expect(page.locator('.session-console')).toBeVisible();
  // The logs button is a toggle: click it only when the panel is closed.
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

test.describe('Ubuntu 18.04 i386 XFCE session (Xorg + XFCE, real boot)', () => {
  test.skip(!assetsPresent, 'Ubuntu XFCE image missing: set VM_E2E_ASSETS=1 once published.');

  test('boots a real XFCE session, hands it back to the browser and restarts', async ({ page }) => {
    // Two XFCE boots under software emulation: explicit 30 min budget.
    test.setTimeout(1_800_000);

    const { serial, state } = await openXfceSession(page);

    await expect(serial).toHaveValue(/LUMIBOOT_ROOT_DEVICE_READY:\/dev\/sda/, {
      timeout: 60_000,
    });
    // No failed filesystem probe: the marker above must mean a readable root.
    await expect(serial).not.toHaveValue(/LUMIBOOT_ROOT_DEVICE_FAILED/);

    // 1. Graphical session proof from the guest marker on ttyS0, never simulated.
    const proof = await waitForDesktopProof(page);
    if (proof !== 'ready') {
      const value = await dumpSerial(page, serial, proof);
      // Serial output is attached for diagnosis (X, fbdev, dbus, startx).
      expect(
        proof,
        `Graphical session not proven (status=${proof}). ` +
          `Expected marker: ${READY_MARKER}.\nSerial output:\n${value}`,
      ).toBe('ready');
    }

    // 2. `running` is only emitted AFTER `DESKTOP_READY`, see V86Instance.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: RUNNING_TIMEOUT_MS });

    // 3. The canvas is displayed and sized in graphical mode (hidden in text mode).
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
    await page.screenshot({ path: 'test-results/ubuntu-xfce-boot.png' });
    await page.locator('.session-console').screenshot({ path: 'test-results/ubuntu-xfce-vga.png' });

    // 5. No pending `login:` prompt; no command is typed in the GUI.
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

/** Restart recreates a fresh session: show the logs again and re-prove. */
async function openRestartProof(page: Page): Promise<'ready' | 'failed' | 'error' | 'timeout'> {
  await expect(page.locator('.session-console')).toBeVisible();
  const logsButton = page.getByRole('button', { name: 'Logs' });
  if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
    await logsButton.click();
  }
  return waitForDesktopProof(page);
}
