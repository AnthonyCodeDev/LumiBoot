import { expect, test } from '@playwright/test';

/**
 * Validation en Chromium RÉEL du module d'orchestration Pointer Lock, sans
 * démarrer de VM : le module est chargé tel quel depuis le serveur de dev Vite
 * (`/src/components/session/pointer-lock.ts`) puis piloté par de VRAIS gestes
 * utilisateur (`page.mouse.click`), condition indispensable pour que le
 * navigateur accepte `requestPointerLock`.
 *
 * Preuves : un clic capture (un seul curseur, celui de l'invité), la libération
 * (Échap natif = `pointerlockchange`, ici déclenchée via `exitPointerLock` car
 * Chromium headless n'intercepte pas Échap) restaure le curseur hôte, un clic
 * recapture, et `dispose` libère.
 *
 * La séquence « Échap natif » est couverte par les tests unitaires
 * (`pointerlockchange` + classe retirée) ; ce test prouve le comportement dans un
 * vrai moteur de rendu.
 */
test.describe('Capture souris (Pointer Lock) — module réel dans Chromium', () => {
  test('capture au clic, libère (Échap natif simulé), recapture, puis libère au dispose', async ({
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
      screen.className = 'v86-screen';
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

    // Avant tout clic : aucun verrou, aucun curseur masqué.
    expect(await isLockedToScreen()).toBe(false);
    expect(await hasLockedClass()).toBe(false);

    // Clic réel (geste utilisateur) : capture + curseur hôte masqué (classe).
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    await expect.poll(hasLockedClass).toBe(true);

    // Libération (Échap natif du navigateur => `pointerlockchange`).
    await page.evaluate(() => document.exitPointerLock());
    await expect.poll(isLockedToScreen).toBe(false);
    await expect.poll(hasLockedClass).toBe(false);

    // Nouveau clic explicite : recapture.
    await page.mouse.click(cx, cy);
    await expect.poll(isLockedToScreen).toBe(true);
    // On attend la synchronisation via `pointerlockchange` (classe posée).
    await expect.poll(hasLockedClass).toBe(true);

    // `dispose` (arrêt/démontage de session) : libère le verrou.
    await page.evaluate(() =>
      (window as unknown as { __plHandle?: { dispose: () => void } }).__plHandle?.dispose(),
    );
    await expect.poll(isLockedToScreen).toBe(false);

    // Séquence d'états réelle observée : true → false → true → false.
    const states = await page.evaluate(
      () => (window as unknown as { __plStates?: boolean[] }).__plStates ?? [],
    );
    expect(states).toEqual([true, false, true, false]);
  });
});
