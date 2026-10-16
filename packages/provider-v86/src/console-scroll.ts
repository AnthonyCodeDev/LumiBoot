import type { V86 } from 'v86';

/**
 * Séquence make+break de `Shift+PageUp` : le scrollback vers le haut de la
 * console Linux. `0x2a` est le make de Shift gauche, `0xaa` son break.
 */
const SHIFT_PAGE_UP = [0x2a, 0xe0, 0x49, 0xe0, 0xc9, 0xaa];

/** Séquence make+break de `Shift+PageDown` : retour vers le bas. */
const SHIFT_PAGE_DOWN = [0x2a, 0xe0, 0x51, 0xe0, 0xd1, 0xaa];

/** Délai minimal entre deux injections : évite de saturer l'invité. */
const WHEEL_THROTTLE_MS = 35;

/**
 * Traduit la molette en touches Shift+PageUp/PageDown quand l'écran est en
 * mode TEXTE (scrollback de la console Linux). En mode graphique, on ne fait
 * rien : v86 relaie déjà la molette à la souris PS/2 invitée.
 *
 * @returns Fonction de détachement de l'écouteur `wheel`.
 */
export function attachConsoleWheelScroll(screen: HTMLElement, emulator: V86): () => void {
  let lastSentAt = 0;

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    // Mode graphique : le div texte est masqué, on laisse v86 gérer la souris.
    const textMode = screen.querySelector<HTMLElement>('.v86-screen-text');
    if (textMode?.style.display === 'none') return;

    // Mode texte : la molette ne doit pas défiler la page hôte.
    event.preventDefault();

    const now = Date.now();
    if (now - lastSentAt < WHEEL_THROTTLE_MS) return;
    lastSentAt = now;

    const scancodes = event.deltaY < 0 ? SHIFT_PAGE_UP : SHIFT_PAGE_DOWN;
    // `keyboard_send_scancodes` est asynchrone : on ignore volontairement la
    // promesse retournée (l'ordre des scancodes est garanti côté v86).
    void emulator.keyboard_send_scancodes(scancodes);
  };

  screen.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    screen.removeEventListener('wheel', onWheel);
  };
}
