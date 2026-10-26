import { useEffect, useState, type RefObject } from 'react';
import { attachPointerLockCapture } from './pointer-lock';

export interface PointerLockCaptureState {
  /** True when the screen really holds the pointer lock. */
  readonly captured: boolean;
  /** True when Pointer Lock is usable in this browser. */
  readonly supported: boolean;
  /** Readable error message on refusal/unavailability, otherwise `null`. */
  readonly error: string | null;
}

function describePointerLockError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Unable to capture the mouse on the screen.';
}

/**
 * Wires the Pointer Lock orchestration to the screen container while the
 * session is active (`enabled`). On stop, on unmount, or when the page loses
 * focus, the lock is released and listeners are detached: no resource and no
 * hidden cursor outlives the session.
 */
export function usePointerLockCapture(
  containerRef: RefObject<HTMLElement>,
  enabled: boolean,
): PointerLockCaptureState {
  const [captured, setCaptured] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || container === null) {
      setCaptured(false);
      return;
    }

    const handle = attachPointerLockCapture({
      container,
      onCaptureChange: (next) => {
        setCaptured(next);
        // A successful capture clears any previous error message.
        if (next) setError(null);
      },
      onError: (cause) => setError(describePointerLockError(cause)),
    });
    setSupported(handle.isSupported());
    setCaptured(handle.isCaptured());
    setError(null);

    return () => {
      handle.dispose();
    };
  }, [containerRef, enabled]);

  return { captured, supported, error };
}
