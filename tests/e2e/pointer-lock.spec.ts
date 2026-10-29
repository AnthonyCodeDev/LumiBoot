import { expect, test } from '@playwright/test';

// Real Pointer Lock behaviour in Chromium: the module is loaded from the dev server.
test.describe('Mouse capture (Pointer Lock) - real module in Chromium', () => {
  test('captures on click, releases (simulated native Escape), recaptures, then releases on dispose', async ({
    page,
  }) => {
    await page.goto('/');

    await page.evaluate(async () => {
      const mod = await import('/src/components/session/pointer-lock.ts');
      const state = window as unknown as {
        __plStates?: boolean[];
        __plHandle?: { dispose: () => void };
      };
      const container = document.createElement('div');
      container.id = 'pl-container';
      container.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;';

      const screen = document.createElement('div');
      screen.id = 'pl-screen';
      // Standard display contract: the target is no longer tied to `.v86-screen`.
      screen.setAttribute('data-vm-display', 'screen');
      screen.style.cssText = 'width:240px;height:120px;background:#000;';

      const canvas = document.createElement('canvas');
      canvas.id = 'pl-canvas';
      canvas.width = 240;
      canvas.height = 120;
      screen.append(canvas);
      container.append(screen);
      document.body.append(container);

      state.__plStates = [];
      state.__plHandle = mod.attachPointerLockCapture({
        container,
        onCaptureChange: (captured: boolean) => {
          state.__plStates?.push(captured);
        },
      });
    });

    const box = await page.locator('#pl-screen').boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    const isLockedToScreen = (): Promise<boolean> =>
      page.evaluate(() => document.pointerLockElement?.id === 'pl-screen');
    const hasLockedClass = (): Promise<boolean> =>
      page.evaluate(
        () =>
          document.querySelector('#pl-screen')?.classList.contains('is-pointer-locked') ?? false,
      );

    // Before any click: no lock, no hidden cursor.
    expect(await isLockedToScreen()).toBe(false);
    expect(await hasLockedClass()).toBe(false);

    // Real user click: capture, with the host cursor hidden by a class.
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    await expect.poll(hasLockedClass).toBe(true);

    // Release from the native browser Escape, which yields a `pointerlockchange`.
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(isLockedToScreen).toBe(false);
    await expect.poll(hasLockedClass).toBe(false);

    // New explicit click: recapture.
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    // Wait for the class applied through `pointerlockchange`.
    await expect.poll(hasLockedClass).toBe(true);

    // `dispose`, called on session stop or unmount, releases the lock.
    await page.evaluate(() =>
      (window as unknown as { __plHandle?: { dispose: () => void } }).__plHandle?.dispose(),
    );
    await expect.poll(isLockedToScreen).toBe(false);

    // Real observed state sequence: true -> false -> true -> false.
    const states = await page.evaluate(
      () => (window as unknown as { __plStates?: boolean[] }).__plStates ?? [],
    );
    expect(states).toEqual([true, false, true, false]);
  });
});
