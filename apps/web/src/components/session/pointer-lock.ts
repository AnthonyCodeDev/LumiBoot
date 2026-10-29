/** Pointer Lock orchestration for a VM screen: one visible cursor, the guest's. */
import { STANDARD_VM_DISPLAY, type VMDisplay } from '@lumiboot/vm-core';

/** Default screen selector from the standard display contract. */
export const DEFAULT_SCREEN_SELECTOR = STANDARD_VM_DISPLAY.screenSelector;

export const POINTER_LOCKED_CLASS = 'is-pointer-locked';

/** Minimal element shape for browsers that return `void`. */
type PointerLockElementLike = HTMLElement & {
  requestPointerLock(options?: PointerLockOptions): Promise<void> | void;
};

export interface PointerLockCaptureOptions {
  readonly container: HTMLElement;
  /** Its `screen` target is the one that gets locked. */
  readonly display?: VMDisplay;
  /** Takes precedence over `display`. */
  readonly screenSelector?: string;
  readonly onCaptureChange?: (captured: boolean) => void;
  readonly onError?: (error: unknown) => void;
}

export interface PointerLockCaptureHandle {
  requestCapture(): void;
  isCaptured(): boolean;
  isSupported(): boolean;
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

/** Only presses inside the screen capture. */
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
    if (doc.pointerLockElement !== null) return;
    requestLock(screen);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (disposed || !supported) return;
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
    container.addEventListener('pointerdown', onPointerDown);
    win?.addEventListener('blur', onWindowBlur);
  }
  // An already active lock is reflected without waiting for an event.
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
