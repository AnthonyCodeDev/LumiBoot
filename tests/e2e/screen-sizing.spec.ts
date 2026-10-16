import { expect, test, type Page } from '@playwright/test';

/**
 * Validation du dimensionnement du composant « screen » général, sans démarrer
 * de VM : on charge la vraie app/CSS depuis `/`, puis on injecte la structure
 * réelle produite par le provider v86 (`.session-screen` > `.session-toolbar` +
 * `.session-viewport` > `.session-console` > `.v86-console` > `.v86-screen` >
 * `.v86-screen-text` + `canvas.v86-screen-canvas`, avec `.v86-serial`).
 *
 * Preuves exigées :
 *  (a) aucun scroll vertical parasite de la page ;
 *  (b) le viewport de session ne dépasse jamais 80 % de la hauteur de fenêtre ;
 *  (c) en mode graphique, le canvas préserve son ratio intrinsèque (non étiré) ;
 *  (d) aucun débordement horizontal.
 */

type ScreenMode = 'graphical' | 'text';

interface InjectOptions {
  mode: ScreenMode;
  logs: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
}

interface SizingMeasure {
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  canvasVisible: boolean;
}

async function injectSessionScreen(page: Page, options: InjectOptions): Promise<void> {
  await page.evaluate((opts) => {
    const intrinsicWidth = opts.canvasWidth ?? 1024;
    const intrinsicHeight = opts.canvasHeight ?? 768;

    document.body.innerHTML = '';

    const session = document.createElement('div');
    session.className = 'session-screen';

    const toolbar = document.createElement('div');
    toolbar.className = 'session-toolbar';
    toolbar.style.height = '60px';
    toolbar.textContent = 'toolbar';

    const viewport = document.createElement('div');
    viewport.className = 'session-viewport';

    const consoleEl = document.createElement('div');
    consoleEl.className = opts.logs ? 'session-console' : 'session-console logs-hidden';

    const v86 = document.createElement('div');
    v86.className = 'v86-console';

    const screen = document.createElement('div');
    screen.className = 'v86-screen';

    const text = document.createElement('div');
    text.className = 'v86-screen-text';
    text.style.whiteSpace = 'pre';
    text.style.font = '14px monospace';
    text.style.lineHeight = '14px';
    if (opts.mode === 'text') {
      const line = 'X'.repeat(80);
      text.textContent = Array.from({ length: 25 }, () => line).join('\n');
      text.style.display = 'block';
    } else {
      text.style.display = 'none';
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'v86-screen-canvas';
    canvas.width = intrinsicWidth;
    canvas.height = intrinsicHeight;
    if (opts.mode === 'graphical') {
      // Imite v86 : styles inline en px que la CSS doit neutraliser.
      canvas.style.display = 'block';
      canvas.style.width = `${intrinsicWidth}px`;
      canvas.style.height = `${intrinsicHeight}px`;
    } else {
      canvas.style.display = 'none';
    }

    screen.append(text, canvas);

    const serial = document.createElement('textarea');
    serial.className = 'v86-serial';
    serial.readOnly = true;
    serial.value = Array.from({ length: 12 }, (_, i) => `[    0.000000] log ${i}`).join('\n');

    v86.append(screen, serial);
    consoleEl.append(v86);
    viewport.append(consoleEl);
    session.append(toolbar, viewport);
    document.body.append(session);
  }, options);
}

async function measure(page: Page): Promise<SizingMeasure> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const viewport = document.querySelector<HTMLElement>('.session-viewport')!;
    const screen = document.querySelector<HTMLElement>('.v86-screen')!;
    const canvas = document.querySelector<HTMLCanvasElement>('.v86-screen-canvas')!;
    const viewportBox = viewport.getBoundingClientRect();
    const screenBox = screen.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: doc.scrollWidth,
      scrollHeight: doc.scrollHeight,
      viewportWidth: viewportBox.width,
      viewportHeight: viewportBox.height,
      screenWidth: screenBox.width,
      screenHeight: screenBox.height,
      canvasWidth: canvasBox.width,
      canvasHeight: canvasBox.height,
      canvasVisible: canvas.style.display !== 'none',
    };
  });
}

function expectNoOverflow(measurement: SizingMeasure): void {
  // (a) pas de scroll vertical parasite.
  expect(measurement.scrollHeight).toBeLessThanOrEqual(measurement.innerHeight + 1);
  // (b) plafond : le viewport ne dépasse jamais 80 % de la fenêtre.
  expect(measurement.viewportHeight).toBeLessThanOrEqual(measurement.innerHeight * 0.8 + 1);
  // (d) pas de débordement horizontal.
  expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.innerWidth + 1);
}

test.describe('Dimensionnement du composant screen — CSS réel dans Chromium', () => {
  const desktopSizes = [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ];

  for (const size of desktopSizes) {
    test(`mode graphique (VGA 1024x768) sans logs — ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await injectSessionScreen(page, { mode: 'graphical', logs: false });

      const m = await measure(page);
      expectNoOverflow(m);
      // (c) ratio intrinsèque préservé (ni étiré, ni écrasé).
      const expectedRatio = 1024 / 768;
      const actualRatio = m.canvasWidth / m.canvasHeight;
      expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.02);
      expect(m.canvasWidth).toBeLessThanOrEqual(m.viewportWidth + 1);
      // Surface noire ajustée au contenu rendu (pas de bandes noires latérales).
      expect(Math.abs(m.screenWidth - m.canvasWidth)).toBeLessThanOrEqual(2);
      // Repli : la coque reste pleine largeur (un `fit-content` sur le
      // conteneur se baserait sur la taille intrinsèque du canvas, pas sur sa
      // taille contrainte en hauteur — circularité vérifiée empiriquement).
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });

    test(`mode graphique (VGA 1024x768) avec logs série — ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await injectSessionScreen(page, { mode: 'graphical', logs: true });

      const m = await measure(page);
      expectNoOverflow(m);
      const expectedRatio = 1024 / 768;
      const actualRatio = m.canvasWidth / m.canvasHeight;
      expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.02);
      // Écran + logs restent sous le plafond : l'écran se réduit.
      expect(m.screenHeight).toBeLessThan(m.viewportHeight);
      // La coque reste dans la largeur de la fenêtre.
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });

    test(`mode texte (80x25) sans logs — ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await injectSessionScreen(page, { mode: 'text', logs: false });

      const m = await measure(page);
      expectNoOverflow(m);
      expect(m.canvasVisible).toBe(false);
      // L'écran texte reste dans la largeur disponible (coque pleine largeur,
      // repli assumé identique au mode graphique).
      expect(m.screenWidth).toBeLessThanOrEqual(m.viewportWidth + 1);
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });
  }

  test('résolution invitée large (1920x1080) : pas de débordement, ratio préservé', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await injectSessionScreen(page, {
      mode: 'graphical',
      logs: false,
      canvasWidth: 1920,
      canvasHeight: 1080,
    });

    const m = await measure(page);
    expectNoOverflow(m);
    const expectedRatio = 1920 / 1080;
    const actualRatio = m.canvasWidth / m.canvasHeight;
    expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.02);
  });
});
