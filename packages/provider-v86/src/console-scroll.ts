import type { V86 } from 'v86';

/**
 * Make+break sequence for `Shift+PageUp`: scrollback up in the Linux console.
 * `0x2a` is the left Shift make code, `0xaa` its break code.
 */
const SHIFT_PAGE_UP = [0x2a, 0xe0, 0x49, 0xe0, 0xc9, 0xaa];

/** Make+break sequence for `Shift+PageDown`: scroll back down. */
const SHIFT_PAGE_DOWN = [0x2a, 0xe0, 0x51, 0xe0, 0xd1, 0xaa];

/** Minimum delay between two injections: avoids saturating the guest. */
const WHEEL_THROTTLE_MS = 35;

/**
 * Translates the wheel into Shift+PageUp/PageDown keystrokes when the screen is
 * in TEXT mode (Linux console scrollback). In graphics mode, nothing is done:
 * v86 already relays the wheel to the guest PS/2 mouse.
 *
 * @returns Detach function for the `wheel` listener.
 */
export function attachConsoleWheelScroll(screen: HTMLElement, emulator: V86): () => void {
  let lastSentAt = 0;

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    // Graphics mode: the text div is hidden, let v86 handle the mouse.
    const textMode = screen.querySelector<HTMLElement>('.v86-screen-text');
    if (textMode?.style.display === 'none') return;

    // Text mode: the wheel must not scroll the host page.
    event.preventDefault();

    const now = Date.now();
    if (now - lastSentAt < WHEEL_THROTTLE_MS) return;
    lastSentAt = now;

    const scancodes = event.deltaY < 0 ? SHIFT_PAGE_UP : SHIFT_PAGE_DOWN;
    // `keyboard_send_scancodes` is asynchronous: the returned promise is
    // deliberately ignored (scancode order is guaranteed on the v86 side).
    void emulator.keyboard_send_scancodes(scancodes);
  };

  screen.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    screen.removeEventListener('wheel', onWheel);
  };
}
