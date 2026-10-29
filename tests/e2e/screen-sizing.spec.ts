import { expect, test, type Page } from '@playwright/test';

// Sizing of the generic screen component with the real app CSS, no VM started.

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
      // Mimics v86: inline px styles that the CSS must neutralize.
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
  // 1. no parasitic vertical scroll.
  expect(measurement.scrollHeight).toBeLessThanOrEqual(measurement.innerHeight + 1);
  // 2. cap: the viewport never exceeds 80 % of the window.
  expect(measurement.viewportHeight).toBeLessThanOrEqual(measurement.innerHeight * 0.8 + 1);
  // 4. no horizontal overflow.
  expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.innerWidth + 1);
}

test.describe('Sizing of the screen component - real CSS in Chromium', () => {
  const desktopSizes = [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ];

  for (const size of desktopSizes) {
    test(`graphical mode (VGA 1024x768) without logs - ${size.width}x${size.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await injectSessionScreen(page, { mode: 'graphical', logs: false });

      const m = await measure(page);
      expectNoOverflow(m);
      // 3. intrinsic ratio preserved, neither stretched nor squashed.
      const expectedRatio = 1024 / 768;
      const actualRatio = m.canvasWidth / m.canvasHeight;
      expect(Math.abs(actualRatio - expectedRatio)).toBeLessThan(0.02);
      expect(m.canvasWidth).toBeLessThanOrEqual(m.viewportWidth + 1);
      // Black surface fitted to the rendered content, with no side black bars.
      expect(Math.abs(m.screenWidth - m.canvasWidth)).toBeLessThanOrEqual(2);
      // Shell stays full width (`fit-content` would be circular; verified here).
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });

    test(`graphical mode (VGA 1024x768) with serial logs - ${size.width}x${size.height}`, async ({
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
      // Screen + logs stay under the cap: the screen shrinks.
      expect(m.screenHeight).toBeLessThan(m.viewportHeight);
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });

    test(`text mode (80x25) without logs - ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/');
      await injectSessionScreen(page, { mode: 'text', logs: false });

      const m = await measure(page);
      expectNoOverflow(m);
      expect(m.canvasVisible).toBe(false);
      // Text screen stays within the available width (same fallback as graphical).
      expect(m.screenWidth).toBeLessThanOrEqual(m.viewportWidth + 1);
      expect(m.viewportWidth).toBeLessThanOrEqual(m.innerWidth + 1);
    });
  }

  test('wide guest resolution (1920x1080): no overflow, ratio preserved', async ({ page }) => {
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
