/**
 * Pointer Lock orchestration for a VM screen: one visible cursor, the guest's.
 * Never re-injects mouse movement; v86 already forwards relative deltas.
 */
import { STANDARD_VM_DISPLAY, type VMDisplay } from '@lumiboot/vm-core';

/** Default screen selector from the standard display contract. */
export const DEFAULT_SCREEN_SELECTOR = STANDARD_VM_DISPLAY.screenSelector;

/** Class set on the screen only while the lock is held. */
export const POINTER_LOCKED_CLASS = 'is-pointer-locked';

/** Minimal element shape for browsers that return `void`. */
type PointerLockElementLike = HTMLElement & {
  requestPointerLock(options?: PointerLockOptions): Promise<void> | void;
};

export interface PointerLockCaptureOptions {
  /** Container that holds the screen. */
  readonly container: HTMLElement;
  /** Display contract; its `screen` target is the one that gets locked. */
  readonly display?: VMDisplay;
  /** Explicit selector, takes precedence over `display`. */
  readonly screenSelector?: string;
  /** Notified on every real capture change. */
  readonly onCaptureChange?: (captured: boolean) => void;
  /** Notified on refusal or unavailability of Pointer Lock. */
  readonly onError?: (error: unknown) => void;
}

export interface PointerLockCaptureHandle {
  /** Attempts an immediate capture. */
  requestCapture(): void;
  /** Real capture state of this screen. */
  isCaptured(): boolean;
  /** Pointer Lock is usable in this document. */
  isSupported(): boolean;
  /** Detaches every listener and releases the lock if it is ours. */
  dispose(): void;
}

export function isPointerLockSupported(doc: Document): boolean {
  const root = doc.documentElement as PointerLockElementLike | null;
  return (
    root !== null &&
    'pointerLockElement' in doc &&
    typeof doc.exitPointerLock === 'function' &&
    typeof root.requestPointerLock === 'function'
  );
}

/** Capture presses are filtered: only presses inside the screen capture. */
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
    // `cursor: none` only when the screen holds the lock.
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
        /* exit refused: state syncs on pointerlockchange */
      }
    }
  };

  const requestLock = (screen: HTMLElement): void => {
    const el = screen as PointerLockElementLike;
    // The synchronous call preserves the click's "user activation".
    void (async () => {
      try {
        // `unadjustedMovement` requests raw movements; falls back when refused.
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
    // Only the primary button captures.
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
    // `pointerdown` captures on press rather than on release.
    container.addEventListener('pointerdown', onPointerDown);
    win?.addEventListener('blur', onWindowBlur);
  }
  // Sync on mount: an already active lock is reflected without an event.
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
