import { test, type Page } from '@playwright/test';

const assetsPresent = process.env.VM_E2E_ASSETS === '1';

async function installSerialCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (!desc?.set) return;
    Object.defineProperty(HTMLTextAreaElement.prototype, 'value', {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(this: HTMLTextAreaElement, v: string) {
        (window as unknown as { __lumibootSerial?: string }).__lumibootSerial = v;
        desc.set!.call(this, v);
      },
    });
  });
}

async function serialBuffer(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as { __lumibootSerial?: string }).__lumibootSerial ?? '',
  );
}

test.describe('DIAG desktop', () => {
  test.skip(!assetsPresent, 'assets');

  test('diag', async ({ page }) => {
    test.setTimeout(900_000);
    await installSerialCapture(page);

    await page.goto('/');
    await page.getByLabel('Rechercher un système').fill('debian');
    await page.locator('.os-card[data-id="debian-12-i386-desktop"]').click();
    await page.getByRole('button', { name: 'Lancer une session' }).click();
    await page.getByRole('button', { name: 'Logs' }).click();

    // Attendre l'invite shell sur ttyS0.
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(5_000);
      const buf = await serialBuffer(page);
      if (buf.includes('lumiboot@lumiboot')) {
        console.log(`[diag] shell atteint à ~${(i + 1) * 5}s`);
        break;
      }
    }

    const serial = page.locator('.v86-serial');
    await serial.click();

    const commands = [
      'echo DIAG_START',
      'who',
      'loginctl list-sessions --no-pager',
      'systemctl is-enabled lumiboot-desktop-ready.service',
      'systemctl is-active lumiboot-desktop-ready.service',
      'systemctl --failed --no-pager',
      'systemctl status lumiboot-desktop-ready.service --no-pager -l 2>&1 | head -40',
      'ps -eo pid,comm,args 2>&1 | grep -Ei "xorg|xinit|startx|openbox|xterm" | grep -v grep',
      'ls -la /tmp/.X11-unix/ 2>&1',
      'ls -la /var/log/Xorg* 2>&1',
      'echo ---XORGLOG---; grep -aE "X.Org X Server|no screens found|screens found|Using .*driver|vesa|fbdev|Fatal server error|Xorg.wrap" /var/log/Xorg.0.log 2>&1 | head -40',
      'echo ---FB---; ls -la /dev/fb* 2>&1',
      'echo ---DMESG---; dmesg 2>&1 | grep -iE "fb0|vesa|frame buffer|vgacon|Console:" | head -20',
      'echo ---BOCHS-DRM-TEST---; sudo rm -f /etc/modprobe.d/lumiboot-no-drm.conf; sudo modprobe bochs 2>&1; echo rc=$?; sleep 3; ls -la /dev/fb* 2>&1; lsmod | grep -iE "bochs|drm" | head; dmesg | grep -iE "bochs|fb0|frame buffer" | tail -15',
      'cat ~/.bash_profile 2>&1',
      'echo DIAG_END',
    ];
    for (const command of commands) {
      await serial.pressSequentially(`${command}\n`, { delay: 10 });
      await page.waitForTimeout(1_500);
    }

    await page.waitForTimeout(5_000);

    const snapshot = await page.evaluate(() => ({
      state: document.querySelector('.session-state')?.getAttribute('data-state'),
      serialLen: ((window as unknown as { __lumibootSerial?: string }).__lumibootSerial ?? '')
        .length,
      canvasDisplay: document.querySelector<HTMLCanvasElement>('.v86-screen-canvas')?.style.display,
      serial: (window as unknown as { __lumibootSerial?: string }).__lumibootSerial ?? '',
    }));
    console.log(`\n[diag] state=${snapshot.state} canvasDisplay=${snapshot.canvasDisplay}`);
    console.log(`\n=== SÉRIE ===\n${snapshot.serial}\n=== FIN ===\n`);

    await page.screenshot({ path: 'test-results/diag-desktop.png' });
  });
});
