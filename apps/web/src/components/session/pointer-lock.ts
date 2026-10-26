/**
 * Generic mouse capture orchestration (Pointer Lock API) for a VM screen.
 *
 * UX goal: ONE visible cursor — the guest's. An explicit press inside the screen
 * locks the pointer to the screen element; the browser then hides the host
 * cursor and delivers RELATIVE movements (`movementX/Y`) to v86, which already
 * forwards them to the guest. `Escape` (handled natively by the browser)
 * releases the pointer and restores the host cursor; a new click recaptures.
 *
 * This module is deliberately independent of v86 and of any OS: it consumes the
 * provider-agnostic display contract `VMDisplay` (marker
 * `data-vm-display="screen"`) instead of an engine-specific selector;
 * - it NEVER re-injects mouse movement (v86 already does);
 * - it only sets `cursor: none` when `document.pointerLockElement` really is
 *   the screen element (synchronization through `pointerlockchange`);
 * - it stays testable without a real browser (jsdom + Pointer Lock mock).
 */
import { STANDARD_VM_DISPLAY, type VMDisplay } from '@lumiboot/vm-core';

/**
 * Default screen selector, taken from the standard display contract
 * (`data-vm-display="screen"`). No engine is targeted by name: a future
 * non-v86 engine using the same marker is supported without changes.
 */
export const DEFAULT_SCREEN_SELECTOR = STANDARD_VM_DISPLAY.screenSelector;

/** Class set on the screen ONLY while the lock is effectively held. */
export const POINTER_LOCKED_CLASS = 'is-pointer-locked';

/** Minimal `Element` shape for older browsers (`void` return). */
type PointerLockElementLike = HTMLElement & {
  requestPointerLock(options?: PointerLockOptions): Promise<void> | void;
};

export interface PointerLockCaptureOptions {
  /** Container (e.g. `.session-console`) that holds the screen. */
  readonly container: HTMLElement;
  /**
   * Engine display contract (fallback: the standard contract). Its `screen`
   * target is the one that gets locked.
   */
  readonly display?: VMDisplay;
  /** Explicit screen selector (takes precedence over `display`). */
  readonly screenSelector?: string;
  /** Notified on every real capture state change. */
  readonly onCaptureChange?: (captured: boolean) => void;
  /** Notified on refusal/error/unavailability of Pointer Lock. */
  readonly onError?: (error: unknown) => void;
}

export interface PointerLockCaptureHandle {
  /** Attempts an immediate capture (explicit click or programmatic call). */
  requestCapture(): void;
  /** Real capture state of THIS screen (never a simulated state). */
  isCaptured(): boolean;
  /** True when Pointer Lock is really usable in this document. */
  isSupported(): boolean;
  /** Detaches every listener and releases the lock if it is ours. */
  dispose(): void;
}

/** Is Pointer Lock really available in this document? */
export function isPointerLockSupported(doc: Document): boolean {
  const root = doc.documentElement as PointerLockElementLike | null;
  return (
    root !== null &&
    'pointerLockElement' in doc &&
    typeof doc.exitPointerLock === 'function' &&
    typeof root.requestPointerLock === 'function'
  );
}

/**
 * Attaches the Pointer Lock orchestration to the screen container.
 *
 * Capture presses are listened for on the container, then filtered: only presses
 * whose target is INSIDE the screen capture. Clicks on controls outside the
 * screen (toolbar, logs…) therefore never trigger a capture.
 */
export function attachPointerLockCapture(
  options: PointerLockCaptureOptions,
): PointerLockCaptureHandle {
  const { container } = options;
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const selector =
    options.screenSelector ?? (options.display ?? STANDARD_VM_DISPLAY).screenSelector;
  const supported = isPointerLockSupported(doc);

  let captured = false;
  let disposed = false;

  const getScreen = (): HTMLElement | null => container.querySelector<HTMLElement>(selector);

  const setCaptured = (next: boolean): void => {
    if (captured === next) return;
    captured = next;
    options.onCaptureChange?.(captured);
  };

  const sync = (): void => {
    const screen = getScreen();
    const locked = screen !== null && doc.pointerLockElement === screen;
    // `cursor: none` only when the screen REALLY holds the lock.
    screen?.classList.toggle(POINTER_LOCKED_CLASS, locked);
    setCaptured(locked);
  };

  /** Releases the lock only when it belongs to our screen. */
  const releaseOurLock = (): void => {
    if (doc.pointerLockElement === null) return;
    if (doc.pointerLockElement === getScreen()) {
      try {
        doc.exitPointerLock();
      } catch {
        /* exit refused: stay consistent through pointerlockchange */
      }
    }
  };

  const requestLock = (screen: HTMLElement): void => {
    const el = screen as PointerLockElementLike;
    // The synchronous call preserves the click's "user activation".
    void (async () => {
      try {
        // `unadjustedMovement` = raw movements, without OS acceleration
        // (like v86). Falls back to no option if the browser refuses it.
        await el.requestPointerLock({ unadjustedMovement: true });
      } catch (error) {
        if (disposed) return;
        try {
          await el.requestPointerLock();
        } catch (fallbackError) {
          if (!disposed) options.onError?.(fallbackError ?? error);
        }
      }
    })();
  };

  const requestCapture = (): void => {
    if (disposed) return;
    if (!supported) {
      options.onError?.(new Error('Pointer capture is not available in this browser.'));
      return;
    }
    const screen = getScreen();
    if (screen === null) return;
    if (doc.pointerLockElement === screen) return;
    // Another element holds the lock: we do not steal it.
    if (doc.pointerLockElement !== null) return;
    requestLock(screen);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (disposed || !supported) return;
    // Like the former `click` event, only the primary button captures.
    if (event.button !== 0) return;
    if (doc.pointerLockElement !== null) return;
    const screen = getScreen();
    if (screen === null) return;
    const target = event.target as Node | null;
    if (target === null || !screen.contains(target)) return;
    requestCapture();
  };

  const onPointerLockChange = (): void => {
    if (disposed) return;
    sync();
  };

  const onPointerLockError = (event: Event): void => {
    if (disposed) return;
    options.onError?.(event);
    sync();
  };

  const onVisibilityChange = (): void => {
    if (disposed) return;
    if (doc.visibilityState === 'hidden') releaseOurLock();
  };

  const onWindowBlur = (): void => {
    if (disposed) return;
    releaseOurLock();
  };

  if (supported) {
    doc.addEventListener('pointerlockchange', onPointerLockChange);
    doc.addEventListener('pointerlockerror', onPointerLockError);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    // `pointerdown` captures on press, without waiting for the release that
    // fires `click`.
    container.addEventListener('pointerdown', onPointerDown);
    win?.addEventListener('blur', onWindowBlur);
  }
  // Synchronize on mount: an already active lock (StrictMode, remount) is
  // reflected without waiting for an event.
  sync();

  return {
    requestCapture,
    isCaptured: () => captured,
    isSupported: () => supported,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (supported) {
        doc.removeEventListener('pointerlockchange', onPointerLockChange);
        doc.removeEventListener('pointerlockerror', onPointerLockError);
        doc.removeEventListener('visibilitychange', onVisibilityChange);
        container.removeEventListener('pointerdown', onPointerDown);
        win?.removeEventListener('blur', onWindowBlur);
      }
      releaseOurLock();
      getScreen()?.classList.remove(POINTER_LOCKED_CLASS);
      setCaptured(false);
    },
  };
}
