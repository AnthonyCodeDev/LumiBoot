import { expect, test } from '@playwright/test';

/**
 * Real boot of Debian 12 i386 in v86.
 *
 * This test is only enabled when the Debian artifacts are really published
 * (rootfs.img, vmlinuz-686, initrd.img, manifest.json) and the image is marked
 * as available. It NEVER replaces a mocked test with proof of operation:
 * without artifacts it is explicitly skipped, not "passed".
 *
 *   VM_E2E_ASSETS=1 pnpm test:e2e
 */
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

test.describe('Debian 12 i386 session (v86, real boot)', () => {
  test.skip(!assetsPresent, 'Debian artifacts missing: set VM_E2E_ASSETS=1.');

  test('boots a real Debian, runs guest commands and restarts', async ({ page }) => {
    // Two complete boots of a systemd Debian under software emulation:
    // ~60-90 s per boot of wall-clock time. Explicit budget, no shortcuts.
    test.setTimeout(600_000);
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    // The mother page preselects the BEST Debian variant (XFCE, which starts
    // Xorg and switches the screen to graphical mode). This test targets the
    // console variant: it is selected EXPLICITLY to guarantee a text-mode boot
    // (VGA/tty1 login, no X session).
    await page.getByRole('button', { name: 'Choose variant' }).click();
    await page.getByRole('button', { name: 'Debian CLI', exact: true }).click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);

    // The console container stays mounted during the whole boot.
    await expect(page.locator('.session-console')).toBeVisible();

    // Serial logs are hidden by default: show them so `.v86-serial` can be
    // read/typed into during the rest of the test.
    await page.getByRole('button', { name: 'Logs' }).click();

    const state = page.locator('.session-toolbar');
    // `running` = marker emitted by the guest Debian on ttyS0, not a timer.
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    // The serial output lives in the *value* of the textarea (not its text
    // content): `toContainText` stays empty even when the guest talks.
    // The login prompt is awaited before typing (the shell needs a few seconds
    // to appear after the readiness marker).
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 60_000 });
    await serial.click();
    for (const command of ['uname -a', 'cat /etc/os-release', 'echo LumiBootOK']) {
      await serial.pressSequentially(`${command}\n`, { delay: 25 });
    }
    // Proofs produced by the guest, never by React.
    await expect(serial).toHaveValue(/Debian GNU\/Linux 12 \(bookworm\)/, { timeout: 30_000 });
    await expect(serial).toHaveValue(/LumiBootOK/, { timeout: 30_000 });

    // VGA autologin (tty1): the user must never type their login.
    // The VGA console in text mode (vgacon, no bochs-drm framebuffer) must show
    // a logged-in `lumiboot@lumiboot` shell with the `automatic login` banner,
    // and must NOT stay blocked on a pending `login:` prompt waiting for input
    // (generous timeout: software emulation needs ~1-2 min to stabilize the
    // text screen).
    // Note: the autologin banner itself contains the `login:` string, so the
    // absence of a *pending* prompt is checked (screen ending with `login:`)
    // rather than a naive absence of the substring.
    const vga = page.locator('.v86-screen-text');
    await expect(vga).toContainText(/lumiboot@lumiboot/, { timeout: 180_000 });
    const vgaText = (await vga.textContent()) ?? '';
    expect(vgaText).toContain('lumiboot@lumiboot');
    expect(vgaText).toContain('automatic login');
    expect(vgaText.trim()).not.toMatch(/login:\s*$/);

    // Pointer Lock capture: a click inside the screen locks the pointer (a
    // single visible cursor, the guest one). Headless Chromium does not
    // intercept Escape: the lock is released through the same
    // `pointerlockchange` path.
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
