import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_VM_DISPLAY } from '@lumiboot/vm-core';
import {
  attachPointerLockCapture,
  DEFAULT_SCREEN_SELECTOR,
  isPointerLockSupported,
  POINTER_LOCKED_CLASS,
  type PointerLockCaptureHandle,
} from './pointer-lock';

/** Pointer Lock mock for jsdom: lock, unlock and `pointerlockchange` events. */
interface PointerLockMock {
  requestCalls: number;
  exitCalls: number;
  /** Forces a native release plus a `pointerlockchange` event. */
  releaseExternally(): void;
  restore(): void;
}

function installPointerLock(options: { rejectRequest?: boolean } = {}): PointerLockMock {
  const doc = document as Document & { pointerLockElement: Element | null };
  let locked: Element | null = null;

  const originalPointerLockElement = Object.getOwnPropertyDescriptor(doc, 'pointerLockElement');
  const originalExit = Object.getOwnPropertyDescriptor(doc, 'exitPointerLock');
  const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestPointerLock');

  Object.defineProperty(doc, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });

  const exitPointerLock = vi.fn(() => {
    if (locked === null) return;
    locked = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  });
  Object.defineProperty(doc, 'exitPointerLock', {
    configurable: true,
    writable: true,
    value: exitPointerLock,
  });

  const applyLock = (element: Element): Promise<void> => {
    locked = element;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  const requestPointerLock = vi.fn(function (this: Element): Promise<void> {
    if (options.rejectRequest) return Promise.reject(new Error('refused by the browser'));
    return applyLock(this);
  });
  Object.defineProperty(Element.prototype, 'requestPointerLock', {
    configurable: true,
    writable: true,
    value: requestPointerLock,
  });

  const mock: PointerLockMock = {
    get requestCalls() {
      return requestPointerLock.mock.calls.length;
    },
    get exitCalls() {
      return exitPointerLock.mock.calls.length;
    },
    releaseExternally() {
      locked = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
    restore() {
      if (originalPointerLockElement) {
        Object.defineProperty(doc, 'pointerLockElement', originalPointerLockElement);
      } else {
        delete (doc as unknown as Record<string, unknown>)['pointerLockElement'];
      }
      if (originalExit) {
        Object.defineProperty(doc, 'exitPointerLock', originalExit);
      } else {
        delete (doc as unknown as Record<string, unknown>)['exitPointerLock'];
      }
      if (originalRequest) {
        Object.defineProperty(Element.prototype, 'requestPointerLock', originalRequest);
      } else {
        delete (Element.prototype as unknown as Record<string, unknown>)['requestPointerLock'];
      }
    },
  };
  return mock;
}

interface Fixture {
  container: HTMLDivElement;
  screen: HTMLDivElement;
  canvas: HTMLCanvasElement;
  serial: HTMLTextAreaElement;
}

/** Fake screen carrying only the display contract marker, never a v86 class. */
function makeFixture(): Fixture {
  const container = document.createElement('div');
  container.className = 'session-console';
  const screen = document.createElement('div');
  screen.setAttribute('data-vm-display', 'screen');
  const canvas = document.createElement('canvas');
  canvas.className = 'v86-screen-canvas';
  screen.append(canvas);
  const serial = document.createElement('textarea');
  serial.className = 'v86-serial';
  container.append(screen, serial);
  document.body.append(container);
  return { container, screen, canvas, serial };
}

function pointerDownOn(target: Element, button = 0): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
}

describe('pointer-lock — orchestration Pointer Lock', () => {
  let mock: PointerLockMock | null = null;

  afterEach(() => {
    mock?.restore();
    mock = null;
    document.body.innerHTML = '';
  });

  it('is not supported when Pointer Lock is absent', () => {
    expect(isPointerLockSupported(document)).toBe(false);
  });

  it('captures on press inside the screen, before release', () => {
    mock = installPointerLock();
    expect(isPointerLockSupported(document)).toBe(true);

    const { container, screen, canvas } = makeFixture();
    const states: boolean[] = [];
    const handle = attachPointerLockCapture({
      container,
      onCaptureChange: (captured) => states.push(captured),
    });

    // Before any click: no lock, no hidden cursor.
    expect(document.pointerLockElement).toBeNull();
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);

    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBe(screen);
    expect(handle.isCaptured()).toBe(true);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(true);
    expect(states).toEqual([true]);

    handle.dispose();
  });

  it('ignores clicks outside the screen (logs, container): never a stray capture', () => {
    mock = installPointerLock();
    const { container, serial } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    pointerDownOn(container);
    pointerDownOn(serial);

    expect(document.pointerLockElement).toBeNull();
    expect(mock.requestCalls).toBe(0);
    expect(onError).not.toHaveBeenCalled();

    handle.dispose();
  });

  it('releases on pointerlockchange (Escape) and restores the cursor, then recaptures', () => {
    mock = installPointerLock();
    const { container, screen, canvas } = makeFixture();
    const states: boolean[] = [];
    const handle = attachPointerLockCapture({
      container,
      onCaptureChange: (captured) => states.push(captured),
    });

    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    // Escape is native: it releases and fires the event.
    mock.releaseExternally();

    expect(document.pointerLockElement).toBeNull();
    expect(handle.isCaptured()).toBe(false);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);
    expect(states).toEqual([true, false]);

    // New explicit click recaptures.
    pointerDownOn(screen);
    expect(handle.isCaptured()).toBe(true);
    expect(document.pointerLockElement).toBe(screen);

    handle.dispose();
  });

  it('does not request the capture again when the screen is already locked (no duplicate)', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });

    pointerDownOn(canvas);
    pointerDownOn(canvas);
    pointerDownOn(canvas);

    expect(mock.requestCalls).toBe(1);
    handle.dispose();
  });

  it('reports an error when the request is refused and does not hide the cursor', async () => {
    mock = installPointerLock({ rejectRequest: true });
    const { container, screen, canvas } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    pointerDownOn(canvas);

    // Rejection plus fallback without options: let the microtasks finish.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalled();
    expect(handle.isCaptured()).toBe(false);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);
    handle.dispose();
  });

  it('reports the browser pointerlockerror event', () => {
    mock = installPointerLock();
    const { container } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    document.dispatchEvent(new Event('pointerlockerror'));

    expect(onError).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('releases the lock and detaches listeners on dispose', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });

    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    handle.dispose();

    expect(mock.exitCalls).toBeGreaterThan(0);
    expect(document.pointerLockElement).toBeNull();
    expect(handle.isCaptured()).toBe(false);

    // After dispose no listener is active anymore.
    const callsAfterDispose = mock.requestCalls;
    pointerDownOn(canvas);
    expect(mock.requestCalls).toBe(callsAfterDispose);
  });

  it('releases when the tab becomes invisible', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(handle.isCaptured()).toBe(false);
    expect(mock.exitCalls).toBeGreaterThan(0);

    if (original) Object.defineProperty(document, 'visibilityState', original);
    else delete (document as unknown as Record<string, unknown>)['visibilityState'];
    handle.dispose();
  });

  it('releases when the window loses focus', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle: PointerLockCaptureHandle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    window.dispatchEvent(new Event('blur'));

    expect(handle.isCaptured()).toBe(false);
    expect(mock.exitCalls).toBeGreaterThan(0);
    handle.dispose();
  });

  it('exposes a provider-agnostic screen selector (standard contract)', () => {
    expect(DEFAULT_SCREEN_SELECTOR).toBe(STANDARD_VM_DISPLAY.screenSelector);
    expect(DEFAULT_SCREEN_SELECTOR).toBe('[data-vm-display="screen"]');
    // No v86-specific selector leaks into the generic UI.
    expect(DEFAULT_SCREEN_SELECTOR).not.toContain('v86');
  });

  it('ignores a purely v86 screen without the standard display marker', () => {
    mock = installPointerLock();
    const container = document.createElement('div');
    container.className = 'session-console';
    // Legacy screen: v86 class only, no contract marker.
    const legacy = document.createElement('div');
    legacy.className = 'v86-screen';
    const canvas = document.createElement('canvas');
    legacy.append(canvas);
    container.append(legacy);
    document.body.append(container);

    const handle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBeNull();
    expect(mock.requestCalls).toBe(0);
    handle.dispose();
  });

  it('accepts an explicit display contract provided by a future engine', () => {
    mock = installPointerLock();
    const container = document.createElement('div');
    const screen = document.createElement('div');
    screen.setAttribute('data-vm-display', 'framebuffer');
    const canvas = document.createElement('canvas');
    screen.append(canvas);
    container.append(screen);
    document.body.append(container);

    const handle = attachPointerLockCapture({
      container,
      display: {
        screenSelector: '[data-vm-display="framebuffer"]',
        textSelector: '[data-vm-display="text"]',
      },
    });
    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBe(screen);
    handle.dispose();
  });
});

describe('pointer-lock — unsupported', () => {
  it('does not capture and reports unavailability (no listener attached)', () => {
    // jsdom without a mock: no Pointer Lock API.
    const { container, canvas } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    expect(handle.isSupported()).toBe(false);
    pointerDownOn(canvas);
    expect(onError).not.toHaveBeenCalled(); // the click is simply ignored

    handle.requestCapture();
    expect(onError).toHaveBeenCalledTimes(1);

    handle.dispose();
  });
});
