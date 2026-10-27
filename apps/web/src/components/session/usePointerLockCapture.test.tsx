import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePointerLockCapture } from './usePointerLockCapture';
import { POINTER_LOCKED_CLASS } from './pointer-lock';

/** Minimal Pointer Lock mock for jsdom. */
function installPointerLock(): { restore: () => void; exitCalls: number } {
  const doc = document as Document & { pointerLockElement: Element | null };
  let locked: Element | null = null;
  const originalElement = Object.getOwnPropertyDescriptor(doc, 'pointerLockElement');
  const originalExit = Object.getOwnPropertyDescriptor(doc, 'exitPointerLock');
  const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestPointerLock');

  Object.defineProperty(doc, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });
  const exit = vi.fn(() => {
    if (locked === null) return;
    locked = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  });
  Object.defineProperty(doc, 'exitPointerLock', { configurable: true, value: exit });
  const applyLock = (element: Element): Promise<void> => {
    locked = element;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  Object.defineProperty(Element.prototype, 'requestPointerLock', {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      return applyLock(this);
    },
  });

  return {
    get exitCalls() {
      return exit.mock.calls.length;
    },
    restore() {
      if (originalElement) Object.defineProperty(doc, 'pointerLockElement', originalElement);
      else delete (doc as unknown as Record<string, unknown>)['pointerLockElement'];
      if (originalExit) Object.defineProperty(doc, 'exitPointerLock', originalExit);
      else delete (doc as unknown as Record<string, unknown>)['exitPointerLock'];
      if (originalRequest)
        Object.defineProperty(Element.prototype, 'requestPointerLock', originalRequest);
      else delete (Element.prototype as unknown as Record<string, unknown>)['requestPointerLock'];
    },
  } as { restore: () => void; exitCalls: number };
}

interface Fixture {
  ref: { current: HTMLDivElement };
  screen: HTMLDivElement;
  canvas: HTMLCanvasElement;
}

function makeFixture(): Fixture {
  const container = document.createElement('div');
  container.className = 'session-console';
  const screen = document.createElement('div');
  // Display contract marker only, no v86 class.
  screen.setAttribute('data-vm-display', 'screen');
  const canvas = document.createElement('canvas');
  screen.append(canvas);
  container.append(screen);
  document.body.append(container);
  return { ref: { current: container }, screen, canvas };
}

describe('usePointerLockCapture', () => {
  let mock: { restore: () => void; exitCalls: number } | null = null;

  beforeEach(() => {
    mock = installPointerLock();
  });

  afterEach(() => {
    mock?.restore();
    mock = null;
    document.body.innerHTML = '';
  });

  it('captures on press when the session is active and reflects the state', () => {
    const { ref, screen, canvas } = makeFixture();
    const { result } = renderHook(() => usePointerLockCapture(ref, true));

    expect(result.current.captured).toBe(false);
    expect(result.current.supported).toBe(true);

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    expect(result.current.captured).toBe(true);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(true);
  });

  it('does not capture when the session is not active', () => {
    const { ref, canvas } = makeFixture();
    const { result } = renderHook(() => usePointerLockCapture(ref, false));

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    expect(result.current.captured).toBe(false);
  });

  it('releases the lock and the state when the session becomes inactive', () => {
    const { ref, screen, canvas } = makeFixture();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => usePointerLockCapture(ref, enabled),
      { initialProps: { enabled: true } },
    );

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(result.current.captured).toBe(true);

    rerender({ enabled: false });

    expect(result.current.captured).toBe(false);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);
    expect(mock?.exitCalls).toBeGreaterThan(0);
  });

  it('releases the lock on unmount (no orphaned resource)', () => {
    const { ref, canvas } = makeFixture();
    const { result, unmount } = renderHook(() => usePointerLockCapture(ref, true));

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    expect(result.current.captured).toBe(true);

    unmount();

    expect(document.pointerLockElement).toBeNull();
    expect(mock?.exitCalls).toBeGreaterThan(0);
  });
});
