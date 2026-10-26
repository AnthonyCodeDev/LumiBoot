import { expect, test } from '@playwright/test';

/**
 * Validation of the Pointer Lock orchestration module in REAL Chromium, without
 * starting a VM: the module is loaded as is from the Vite dev server
 * (`/src/components/session/pointer-lock.ts`) and then driven by REAL user
 * gestures (`page.mouse.click`), which is required for the browser to accept
 * `requestPointerLock`.
 *
 * Proofs: a click captures (a single cursor, the guest one), releasing (native
 * Escape = `pointerlockchange`, triggered here through `exitPointerLock` because
 * headless Chromium does not intercept Escape) restores the host cursor, a click
 * recaptures, and `dispose` releases.
 *
 * The "native Escape" sequence is covered by the unit tests
 * (`pointerlockchange` + removed class); this test proves the behavior in a real
 * rendering engine.
 */
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

    // Real click (user gesture): capture + host cursor hidden (class).
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    await expect.poll(hasLockedClass).toBe(true);

    // Release (native browser Escape => `pointerlockchange`).
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(isLockedToScreen).toBe(false);
    await expect.poll(hasLockedClass).toBe(false);

    // New explicit click: recapture.
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    // The synchronization through `pointerlockchange` is awaited (class applied).
    await expect.poll(hasLockedClass).toBe(true);

    // `dispose` (session stop/unmount): releases the lock.
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
