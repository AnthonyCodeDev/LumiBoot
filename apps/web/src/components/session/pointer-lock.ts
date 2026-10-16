/**
 * Orchestration générique de la capture souris (Pointer Lock API) pour l'écran
 * d'une VM.
 *
 * Objectif UX : un SEUL curseur visible — celui de l'invité. Un clic explicite
 * dans l'écran verrouille le pointeur sur l'élément écran ; le navigateur masque
 * alors le curseur hôte et livre les mouvements RELATIFS (`movementX/Y`) à v86,
 * qui les relaie déjà à l'invité. `Échap` (géré nativement par le navigateur)
 * libère le pointeur et restaure le curseur hôte ; un nouveau clic recapture.
 *
 * Ce module est volontairement indépendant de v86 et de tout OS :
 * - il ne réinjecte JAMAIS de mouvement souris (v86 le fait déjà) ;
 * - il ne pose `cursor: none` QUE lorsque `document.pointerLockElement` est
 *   réellement l'élément écran (synchronisation via `pointerlockchange`) ;
 * - il reste testable sans navigateur réel (jsdom + mock Pointer Lock).
 */

/** Sélecteur de l'écran émulé injecté par le provider (ex. `.v86-screen`). */
export const DEFAULT_SCREEN_SELECTOR = '.v86-screen';

/** Classe posée sur l'écran UNIQUEMENT pendant le verrouillage effectif. */
export const POINTER_LOCKED_CLASS = 'is-pointer-locked';

/** Forme minimale d'`Element` pour les navigateurs anciens (retour `void`). */
type PointerLockElementLike = HTMLElement & {
  requestPointerLock(options?: PointerLockOptions): Promise<void> | void;
};

export interface PointerLockCaptureOptions {
  /** Conteneur (ex. `.session-console`) dans lequel se trouve l'écran. */
  readonly container: HTMLElement;
  /** Sélecteur de l'élément écran à verrouiller (défaut `.v86-screen`). */
  readonly screenSelector?: string;
  /** Notifié à chaque changement réel d'état de capture. */
  readonly onCaptureChange?: (captured: boolean) => void;
  /** Notifié en cas de refus/erreur/indisponibilité du Pointer Lock. */
  readonly onError?: (error: unknown) => void;
}

export interface PointerLockCaptureHandle {
  /** Tente une capture immédiate (clic explicite ou appel programmatique). */
  requestCapture(): void;
  /** État réel de capture de CET écran (jamais un état simulé). */
  isCaptured(): boolean;
  /** Vrai si le Pointer Lock est réellement utilisable dans ce document. */
  isSupported(): boolean;
  /** Détache tous les écouteurs et libère le verrou s'il est le nôtre. */
  dispose(): void;
}

/** Le Pointer Lock est-il réellement disponible dans ce document ? */
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
 * Attache l'orchestration Pointer Lock au conteneur d'écran.
 *
 * Le clic de capture est écouté sur le conteneur puis filtré : seuls les clics
 * dont la cible est DANS l'écran capturent. Les clics sur les contrôles hors
 * écran (barre d'outils, logs…) ne déclenchent donc jamais de capture.
 */
export function attachPointerLockCapture(
  options: PointerLockCaptureOptions,
): PointerLockCaptureHandle {
  const { container } = options;
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const selector = options.screenSelector ?? DEFAULT_SCREEN_SELECTOR;
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
    // `cursor: none` seulement quand l'écran détient RÉELLEMENT le verrou.
    screen?.classList.toggle(POINTER_LOCKED_CLASS, locked);
    setCaptured(locked);
  };

  /** Libère le verrou uniquement s'il appartient à notre écran. */
  const releaseOurLock = (): void => {
    if (doc.pointerLockElement === null) return;
    if (doc.pointerLockElement === getScreen()) {
      try {
        doc.exitPointerLock();
      } catch {
        /* sortie refusée : on reste cohérent via pointerlockchange */
      }
    }
  };

  const requestLock = (screen: HTMLElement): void => {
    const el = screen as PointerLockElementLike;
    // L'appel synchrone préserve l'« activation utilisateur » du clic.
    void (async () => {
      try {
        // `unadjustedMovement` = mouvements bruts, sans accélération OS
        // (comme v86). Repli sans option si le navigateur refuse l'option.
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
      options.onError?.(
        new Error('La capture du pointeur n’est pas disponible dans ce navigateur.'),
      );
      return;
    }
    const screen = getScreen();
    if (screen === null) return;
    if (doc.pointerLockElement === screen) return;
    // Un autre élément détient le verrou : on ne le vole pas.
    if (doc.pointerLockElement !== null) return;
    requestLock(screen);
  };

  const onClick = (event: MouseEvent): void => {
    if (disposed || !supported) return;
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
    container.addEventListener('click', onClick);
    win?.addEventListener('blur', onWindowBlur);
  }
  // Synchronise au montage : un verrou déjà actif (StrictMode, remount) est
  // reflété sans attendre un événement.
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
        container.removeEventListener('click', onClick);
        win?.removeEventListener('blur', onWindowBlur);
      }
      releaseOurLock();
      getScreen()?.classList.remove(POINTER_LOCKED_CLASS);
      setCaptured(false);
    },
  };
}
