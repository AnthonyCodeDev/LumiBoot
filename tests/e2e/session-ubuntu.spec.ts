import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

// Real Ubuntu 18.04 i386 boot in v86; skipped unless VM_E2E_ASSETS=1 and published.
const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/ubuntu-18-i386/manifest.json'));

test.describe('Ubuntu 18.04 LTS i386 session (v86, real boot)', () => {
  test.skip(!assetsPresent, 'Ubuntu artifacts missing: set VM_E2E_ASSETS=1 once published.');

  test('boots a real Ubuntu, runs guest commands and restarts', async ({ page }) => {
    // Two boots of a systemd Ubuntu under software emulation: explicit budget.
    test.setTimeout(600_000);
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('ubuntu');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    // The mother preselects XFCE: select the console variant explicitly.
    await page.getByRole('button', { name: 'Choose variant' }).click();
    // The label carries the architecture suffix: anchor on the exact variant.
    await page.getByRole('button', { name: /^Ubuntu CLI\b/ }).click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    // The console container stays mounted during the whole boot.
    await expect(page.locator('.session-console')).toBeVisible();

    // Logs are collapsed by default: open them to type on ttyS0.
    const logsButton = page.getByRole('button', { name: 'Logs' });
    if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
      await logsButton.click();
    }

    const state = page.locator('.session-toolbar');
    // `running` = marker emitted by the guest Ubuntu on ttyS0, not a timer.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    // Initramfs marker; software emulation can be slow: wide budget.
    await expect(serial).toHaveValue(/LUMIBOOT_ROOT_DEVICE_READY:\/dev\/sda/, {
      timeout: 60_000,
    });
    // No failed filesystem probe: the marker above must mean a readable root.
    await expect(serial).not.toHaveValue(/LUMIBOOT_ROOT_DEVICE_FAILED/);
    // Output lives in the textarea value, not its text content.
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 60_000 });
    await serial.click();
    for (const command of ['uname -a', 'cat /etc/os-release', 'echo LumiBootOK']) {
      await serial.pressSequentially(`${command}\n`, { delay: 25 });
    }
    // Proofs produced by the guest, never by React.
    await expect(serial).toHaveValue(/Ubuntu 18.04/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LumiBootOK/, { timeout: 30_000 });

    // VGA tty1 autologin: no *pending* `login:` prompt (the banner contains one).
    const vga = page.locator('.v86-screen-text');
    await expect(vga).toContainText(/lumiboot@lumiboot/, { timeout: 180_000 });
    const vgaText = (await vga.textContent()) ?? '';
    expect(vgaText).toContain('lumiboot@lumiboot');
    expect(vgaText).toContain('automatic login');
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // Pointer Lock capture on click; headless Chromium does not intercept Escape.
    await page.locator('.v86-screen').click();
    await expect
      .poll(() =>
        page.evaluate(() => document.pointerLockElement?.classList.contains('v86-screen') ?? false),
      )
      .toBe(true);
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(() => page.evaluate(() => document.pointerLockElement === null)).toBe(true);

    // sudo NOPASSWD for lumiboot from the serial console.
    await serial.pressSequentially('sudo -n whoami\n', { delay: 25 });
    await expect(serial).toHaveValue(/root/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });
  });
});
