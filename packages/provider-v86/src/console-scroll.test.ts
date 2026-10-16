import { afterEach, describe, expect, it, vi } from 'vitest';
import type { V86 } from 'v86';
import { attachConsoleWheelScroll } from './console-scroll';

/** Scancodes make+break attendus (voir `console-scroll.ts`). */
const SHIFT_PAGE_UP = [0x2a, 0xe0, 0x49, 0xe0, 0xc9, 0xaa];
const SHIFT_PAGE_DOWN = [0x2a, 0xe0, 0x51, 0xe0, 0xd1, 0xaa];

interface FakeEmulator {
  readonly emulator: V86;
  readonly keyboard_send_scancodes: ReturnType<typeof vi.fn>;
}

function createEmulator(): FakeEmulator {
  const keyboard_send_scancodes = vi.fn();
  return {
    emulator: { keyboard_send_scancodes } as unknown as V86,
    keyboard_send_scancodes,
  };
}

/**
 * Construit un écran factice contenant `.v86-screen-text`. `display` vaut
 * `null` pour laisser le div visible (mode texte), ou `'none'` pour simuler le
 * mode graphique.
 */
function createScreen(display: string | null): { screen: HTMLElement; text: HTMLElement } {
  const screen = document.createElement('div');
  screen.className = 'v86-screen';

  const text = document.createElement('div');
  text.className = 'v86-screen-text';
  if (display !== null) text.style.display = display;

  screen.append(text);
  document.body.append(screen);
  return { screen, text };
}

function dispatchWheel(screen: HTMLElement, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true });
  screen.dispatchEvent(event);
  return event;
}

describe('attachConsoleWheelScroll', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('molette vers le haut : envoie Shift+PageUp et bloque le défilement', () => {
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen(null);
    const detach = attachConsoleWheelScroll(screen, emulator);

    const event = dispatchWheel(screen, -120);

    expect(event.defaultPrevented).toBe(true);
    expect(keyboard_send_scancodes).toHaveBeenCalledTimes(1);
    expect(keyboard_send_scancodes).toHaveBeenCalledWith(SHIFT_PAGE_UP);

    detach();
  });

  it('molette vers le bas : envoie Shift+PageDown après le throttle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen(null);
    const detach = attachConsoleWheelScroll(screen, emulator);

    dispatchWheel(screen, 120);
    expect(keyboard_send_scancodes).toHaveBeenCalledWith(SHIFT_PAGE_DOWN);

    // Hors fenêtre de throttle : un nouvel événement repart.
    keyboard_send_scancodes.mockClear();
    vi.setSystemTime(10_100);
    dispatchWheel(screen, 120);
    expect(keyboard_send_scancodes).toHaveBeenCalledWith(SHIFT_PAGE_DOWN);

    detach();
  });

  it('throttle : ignore les événements trop rapprochés (mais bloque toujours)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen(null);
    const detach = attachConsoleWheelScroll(screen, emulator);

    dispatchWheel(screen, -120);
    const second = dispatchWheel(screen, -120);

    expect(keyboard_send_scancodes).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(true);

    detach();
  });

  it('mode graphique (texte masqué) : n’envoie rien et ne bloque pas', () => {
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen('none');
    const detach = attachConsoleWheelScroll(screen, emulator);

    const event = dispatchWheel(screen, -120);

    expect(event.defaultPrevented).toBe(false);
    expect(keyboard_send_scancodes).not.toHaveBeenCalled();

    detach();
  });

  it('deltaY nul : aucun scancode', () => {
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen(null);
    const detach = attachConsoleWheelScroll(screen, emulator);

    dispatchWheel(screen, 0);
    expect(keyboard_send_scancodes).not.toHaveBeenCalled();

    detach();
  });

  it('la fonction retournée détache l’écouteur', () => {
    const { emulator, keyboard_send_scancodes } = createEmulator();
    const { screen } = createScreen(null);
    const detach = attachConsoleWheelScroll(screen, emulator);

    detach();
    dispatchWheel(screen, -120);

    expect(keyboard_send_scancodes).not.toHaveBeenCalled();
  });
});
