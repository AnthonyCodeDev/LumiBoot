import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/alpine-3-24-x86-64/manifest.json')) &&
  existsSync(join(process.cwd(), 'apps/web/public/v64/v86.wasm'));

test.describe('Alpine 3.24 x86-64 session (v64, real boot)', () => {
  test.skip(!assetsPresent, 'Prepare v64 and Alpine assets, then set VM_E2E_ASSETS=1.');

  test('boots the official x86-64 guest and executes a 64-bit command', async ({ page }) => {
    test.setTimeout(420_000);
    // Direct system page instead of the library card: since the XFCE variant
    // exists, the Alpine card opens it by default (`variantOrder: 1`), while this
    // spec proves the official CLI ISO. The variant dropdown is the only way to
    // pick it, so it is driven through its ARIA roles below.
    await page.goto('/systems/alpine-3-24-x86-64');
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.getByRole('button', { name: 'Choose variant' }).click();
    const cliVariant = page
      .getByRole('listbox', { name: 'Available variants' })
      .getByRole('option', { name: /Alpine Linux CLI/ });
    // Labels are built as "<system> <variant> · <architecture>".
    await expect(cliVariant).toHaveAttribute('aria-selected', 'false');
    await cliVariant.click();
    await expect(page.getByRole('button', { name: 'Choose variant' })).toContainText(
      'Alpine Linux CLI',
    );
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    const state = page.locator('.session-toolbar');
    const serial = page.locator('.v86-serial');
    await expect(serial).toHaveValue(
      /lumiboot@lumiboot|login:|emergency recovery shell|packages install completed with errors/i,
      { timeout: 300_000 },
    );
    const bootOutput = await serial.inputValue();
    if (!bootOutput.includes('lumiboot@lumiboot')) {
      throw new Error(`Alpine did not autologin. Serial tail:\n${bootOutput.slice(-8_000)}`);
    }
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 30_000 });

    // Catches a password-based VGA getty even when the serial console autologged in.
    await expect(serial).toHaveValue(/LUMIBOOT_VGA_AUTOLOGIN/, { timeout: 30_000 });
    await page.screenshot({ path: 'test-results/alpine-vga-autologin.png' });

    const logsButton = page.getByRole('button', { name: 'Logs' });
    await expect(logsButton).toHaveAttribute('aria-pressed', 'false');
    await logsButton.click();
    await expect(logsButton).toHaveAttribute('aria-pressed', 'true');

    await serial.click();
    await serial.pressSequentially(
      'uname -m; id -un; id -gn; tty; test -t 0 && echo LUMIBOOT_TTY_OK; test -f /etc/lumiboot-azerty-ready && echo LUMIBOOT_AZERTY_OK; doas awk -F: \'$1 == "lumiboot" && $2 == "" { print "LUMIBOOT_PASSWORDLESS_OK" }\' /etc/shadow; ls -1 / && test -d /etc && test -d /home && echo LUMIBOOT_LS_OK; doas -n whoami; echo LUMIBOOT_V64_OK\n',
      { delay: 20 },
    );
    await expect(serial).toHaveValue(/\r?\nx86_64\r?\n/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/\r?\nlumiboot\r?\n/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/\/dev\/ttyS0/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LUMIBOOT_TTY_OK/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LUMIBOOT_AZERTY_OK/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LUMIBOOT_PASSWORDLESS_OK/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LUMIBOOT_LS_OK/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/\r?\nroot\r?\n/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LUMIBOOT_V64_OK/, { timeout: 30_000 });
    expect((await serial.inputValue()).match(/LUMIBOOT_VGA_AUTOLOGIN/g)).toHaveLength(1);
    expect(await serial.inputValue()).not.toMatch(
      /can't access tty|job control turned off|unknown user\/group|can't find mount point/,
    );

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });
  });
});
