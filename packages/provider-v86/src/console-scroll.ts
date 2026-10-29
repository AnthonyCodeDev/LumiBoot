import type { V86 } from 'v86';

/** `Shift+PageUp` make/break sequence; `0x2a` is left Shift, `0xaa` its break. */
const SHIFT_PAGE_UP = [0x2a, 0xe0, 0x49, 0xe0, 0xc9, 0xaa];

const SHIFT_PAGE_DOWN = [0x2a, 0xe0, 0x51, 0xe0, 0xd1, 0xaa];

const WHEEL_THROTTLE_MS = 35;

/** Text mode: wheel becomes Shift+PageUp/PageDown; graphics mode keeps the PS/2 mouse. */
export function attachConsoleWheelScroll(screen: HTMLElement, emulator: V86): () => void {
  let lastSentAt = 0;

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    // Graphics mode: the text div is hidden.
    const textMode = screen.querySelector<HTMLElement>('.v86-screen-text');
    if (textMode?.style.display === 'none') return;

    // The wheel must not scroll the host page.
    event.preventDefault();

    const now = Date.now();
    if (now - lastSentAt < WHEEL_THROTTLE_MS) return;
    lastSentAt = now;

    const scancodes = event.deltaY < 0 ? SHIFT_PAGE_UP : SHIFT_PAGE_DOWN;
    // `keyboard_send_scancodes` is async; v86 keeps the scancode order.
    void emulator.keyboard_send_scancodes(scancodes);
  };

  screen.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    screen.removeEventListener('wheel', onWheel);
  };
}
