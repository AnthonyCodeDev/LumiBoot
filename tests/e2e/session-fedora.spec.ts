import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const assetsPresent =
  process.env.VM_E2E_ASSETS === '1' &&
  existsSync(join(process.cwd(), 'apps/web/public/images/fedora-44-x86-64/manifest.json')) &&
  existsSync(join(process.cwd(), 'apps/web/public/v64/v86.wasm'));

test.describe('Fedora 44 x86-64 session (v64, real boot)', () => {
  // The profile is `validated: true` since the measured boot below; only that
  // flag enables the start button, so the assets guard still applies.
  test.skip(!assetsPresent, 'Build and publish the Fedora image, then set VM_E2E_ASSETS=1.');

  test('boots the locally built guest and executes a 64-bit command', async ({ page }) => {
    test.setTimeout(420_000);
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.getByLabel('Search for a system').fill('fedora');
    await page.locator('.os-card').first().click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    const state = page.locator('.session-toolbar');
    const serial = page.locator('.v86-serial');
    // Emitted by lumiboot-ready.service once multi-user is reached: never by the client.
    await expect(serial).toHaveValue(/LUMIBOOT_GUEST_READY:fedora-44-x86-64/, {
      timeout: 300_000,
    });
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 30_000 });
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 30_000 });
    await page.screenshot({ path: 'test-results/fedora-console.png' });

    const logsButton = page.getByRole('button', { name: 'Logs' });
    await expect(logsButton).toHaveAttribute('aria-pressed', 'false');
    await logsButton.click();
    await expect(logsButton).toHaveAttribute('aria-pressed', 'true');

    await serial.click();
    // Every value is produced by a command substitution: the echoed command
    // line never contains the sentinel itself, and Fedora's systemd OSC 3008
    // shell context (printed by the serial terminal as stray text) cannot
    // satisfy an assertion on its own.
    await serial.pressSequentially(
      'echo "UNAME:$(uname -m)"; echo "USER:$(id -un)"; ' +
        'test -f /etc/lumiboot-azerty-ready && echo "AZERTY_$(echo LUMIBOOT_AZERTY_OK)"; ' +
        'echo "SUDO:$(sudo -n whoami)"; echo "OS:$(head -1 /etc/os-release)"\n',
      { delay: 20 },
    );
    await expect(serial).toHaveValue(/UNAME:x86_64/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/USER:lumiboot/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/AZERTY_LUMIBOOT_AZERTY_OK/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/SUDO:root/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/OS:NAME="Fedora/, { timeout: 30_000 });

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });
  });
});
