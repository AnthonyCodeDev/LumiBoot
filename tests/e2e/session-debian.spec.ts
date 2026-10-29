import { expect, test } from '@playwright/test';

// Real Debian 12 i386 boot in v86, skipped unless VM_E2E_ASSETS=1.
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

test.describe('Debian 12 i386 session (v86, real boot)', () => {
  test.skip(!assetsPresent, 'Debian artifacts missing: set VM_E2E_ASSETS=1.');

  test('boots a real Debian, runs guest commands and restarts', async ({ page }) => {
    // Two boots of a systemd Debian under software emulation: explicit budget.
    test.setTimeout(600_000);
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    // The mother preselects XFCE: select the console variant explicitly.
    await page.getByRole('button', { name: 'Choose variant' }).click();
    await page.getByRole('button', { name: 'Debian CLI', exact: true }).click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    // The console container stays mounted during the whole boot.
    await expect(page.locator('.session-console')).toBeVisible();

    // Logs are collapsed by default: open them to type on ttyS0.
    const logsButton = page.getByRole('button', { name: 'Logs' });
    if ((await logsButton.getAttribute('aria-pressed')) !== 'true') {
      await logsButton.click();
    }
    // `logs-hidden` would hide the textarea and break pressSequentially.
    await expect(page.locator('.session-console')).not.toHaveClass(/logs-hidden/);

    const state = page.locator('.session-toolbar');
    // `running` = marker emitted by the guest Debian on ttyS0, not a timer.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    // Output lives in the textarea value, not its text content.
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 60_000 });
    await serial.click();
    for (const command of ['uname -a', 'cat /etc/os-release', 'echo LumiBootOK']) {
      await serial.pressSequentially(`${command}\n`, { delay: 25 });
    }
    // Proofs produced by the guest, never by React.
    await expect(serial).toHaveValue(/Debian GNU\/Linux 12 \(bookworm\)/, { timeout: 30_000 });
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
