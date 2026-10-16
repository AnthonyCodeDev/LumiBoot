import { useEffect, useState, type RefObject } from 'react';
import { attachPointerLockCapture } from './pointer-lock';

export interface PointerLockCaptureState {
  /** Vrai quand l'écran détient réellement le verrou du pointeur. */
  readonly captured: boolean;
  /** Vrai si le Pointer Lock est utilisable dans ce navigateur. */
  readonly supported: boolean;
  /** Message d'erreur lisible en cas de refus/indisponibilité, sinon `null`. */
  readonly error: string | null;
}

function describePointerLockError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Impossible de capturer la souris dans l’écran.';
}

/**
 * Branche l'orchestration Pointer Lock sur le conteneur d'écran tant que la
 * session est active (`enabled`). À l'arrêt, au démontage, ou quand la page
 * perd le focus, le verrou est libéré et les écouteurs détachés : aucune
 * ressource ni curseur masqué ne survit à la session.
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
        // Une capture réussie efface un éventuel message d'erreur précédent.
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
