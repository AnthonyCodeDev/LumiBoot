import type { V64Runtime } from './runtime';

/**
 * A HID boot keyboard's usages (HID 1.11, appendix B.1): the v64 USB plugin
 * holds or releases one key per `keyboard-usage` bus message, `[usage, down]`.
 * Usages 0x04 to 0x65 are the keys, 0xE0 to 0xE7 the eight modifiers.
 */
export const HID_USAGE = {
  enter: 0x28,
  escape: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  delete: 0x4c,
  arrowRight: 0x4f,
  arrowLeft: 0x50,
  arrowDown: 0x51,
  arrowUp: 0x52,
} as const;

/** The modifiers, by their left/right `KeyboardEvent.code`. */
export const HID_MODIFIERS: Readonly<Record<string, number>> = {
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};

/**
 * Physical keys, by `KeyboardEvent.code`: layout-independent, so a US guest
 * always receives the key the visitor pressed at that position.
 */
const CODE_USAGES: Readonly<Record<string, number>> = {
  KeyA: 0x04,
  KeyB: 0x05,
  KeyC: 0x06,
  KeyD: 0x07,
  KeyE: 0x08,
  KeyF: 0x09,
  KeyG: 0x0a,
  KeyH: 0x0b,
  KeyI: 0x0c,
  KeyJ: 0x0d,
  KeyK: 0x0e,
  KeyL: 0x0f,
  KeyM: 0x10,
  KeyN: 0x11,
  KeyO: 0x12,
  KeyP: 0x13,
  KeyQ: 0x14,
  KeyR: 0x15,
  KeyS: 0x16,
  KeyT: 0x17,
  KeyU: 0x18,
  KeyV: 0x19,
  KeyW: 0x1a,
  KeyX: 0x1b,
  KeyY: 0x1c,
  KeyZ: 0x1d,
  Digit1: 0x1e,
  Digit2: 0x1f,
  Digit3: 0x20,
  Digit4: 0x21,
  Digit5: 0x22,
  Digit6: 0x23,
  Digit7: 0x24,
  Digit8: 0x25,
  Digit9: 0x26,
  Digit0: 0x27,
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  CapsLock: 0x39,
  F1: 0x3a,
  F2: 0x3b,
  F3: 0x3c,
  F4: 0x3d,
  F5: 0x3e,
  F6: 0x3f,
  F7: 0x40,
  F8: 0x41,
  F9: 0x42,
  F10: 0x43,
  F11: 0x44,
  F12: 0x45,
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  Insert: 0x49,
  Home: 0x4a,
  PageUp: 0x4b,
  Delete: 0x4c,
  End: 0x4d,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad1: 0x59,
  Numpad2: 0x5a,
  Numpad3: 0x5b,
  Numpad4: 0x5c,
  Numpad5: 0x5d,
  Numpad6: 0x5e,
  Numpad7: 0x5f,
  Numpad8: 0x60,
  Numpad9: 0x61,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
};

/** Named `KeyboardEvent.key` values, for events that carry no `code`. */
const KEY_NAMED_USAGES: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Delete: 0x4c,
  Insert: 0x49,
  Home: 0x4a,
  End: 0x4d,
  PageUp: 0x4b,
  PageDown: 0x4e,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  // A synthetic modifier event: the `code` names a side, `key` does not.
  Shift: 0xe1,
  Control: 0xe0,
  Alt: 0xe2,
  Meta: 0xe3,
};

/** Unshifted US characters, for a `key` that carries no `code`. */
const KEY_CHAR_USAGES: Readonly<Record<string, number>> = {
  ' ': 0x2c,
  '-': 0x2d,
  '=': 0x2e,
  '[': 0x2f,
  ']': 0x30,
  '\\': 0x31,
  ';': 0x33,
  "'": 0x34,
  '`': 0x35,
  ',': 0x36,
  '.': 0x37,
  '/': 0x38,
};

/** The modifier usage of a `KeyboardEvent.code`, or `null`. */
export function modifierUsage(code: string): number | null {
  return HID_MODIFIERS[code] ?? null;
}

/**
 * The HID usage of a keyboard event: `code` first (physical key), then `key`
 * (USB guests are typed into with a **US** layout, so only unshifted US
 * characters are derived from a bare `key`). `null` means "not mapped": the
 * caller drops the event instead of throwing.
 */
export function usageForKeyboardEvent(event: {
  readonly code?: string | undefined;
  readonly key?: string | undefined;
}): number | null {
  const code = event.code ?? '';
  const fromCode = CODE_USAGES[code];
  if (fromCode !== undefined) return fromCode;
  const key = event.key ?? '';
  const named = KEY_NAMED_USAGES[key];
  if (named !== undefined) return named;
  if (key.length !== 1) return null;
  const lower = key.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return 0x04 + (lower.charCodeAt(0) - 'a'.charCodeAt(0));
  if (lower >= '0' && lower <= '9') {
    // '1' to '9' are contiguous from 0x1E, '0' sits after '9'.
    return lower === '0' ? 0x27 : 0x1e + (lower.charCodeAt(0) - '1'.charCodeAt(0));
  }
  return KEY_CHAR_USAGES[lower] ?? null;
}

/** The emulator's bus message: `[usage, down]`. */
export const KEYBOARD_USAGE_CHANNEL = 'keyboard-usage';

/**
 * The part of the runtime the adapter needs. `add_listener`/`remove_listener`
 * are optional: with them, everything held is released and the listeners are
 * removed when the emulator stops, so a disposed session leaves no `window`
 * listener behind.
 */
export type UsbKeyboardEmulator = Pick<V64Runtime, 'bus'> & {
  readonly add_listener?: V64Runtime['add_listener'];
  readonly remove_listener?: V64Runtime['remove_listener'];
};

export interface UsbKeyboardOptions {
  /** Defaults to the browser `window`, as libv86's own keyboard does. */
  readonly target?: EventTarget | null | undefined;
}

/**
 * Routes the page's keyboard to the guest's **USB HID keyboard**. The PS/2
 * path libv86 installs is untouched: a profile that enables `usb.keyboard`
 * gets both, a guest without a PS/2 driver (macOS Lion) only sees this one.
 *
 * Returns an idempotent detach function.
 */
export function attachUsbKeyboard(
  emulator: UsbKeyboardEmulator,
  options: UsbKeyboardOptions = {},
): () => void {
  const bus = emulator.bus;
  const target =
    options.target === undefined ? (typeof window === 'undefined' ? null : window) : options.target;
  if (bus === undefined || target === null) return () => undefined;

  /** The usages the guest has been told are down, in the order they went down. */
  const held = new Set<number>();

  const send = (usage: number, down: boolean): void => {
    try {
      bus.send(KEYBOARD_USAGE_CHANNEL, [usage, down]);
    } catch {
      /* the emulator may already be gone: a stuck key is not worth a crash */
    }
  };

  const press = (usage: number): void => {
    // Auto-repeat and duplicate `keydown`s must not queue a second transition.
    if (held.has(usage)) return;
    held.add(usage);
    send(usage, true);
  };

  const release = (usage: number): void => {
    if (!held.delete(usage)) return;
    send(usage, false);
  };

  const releaseAll = (): void => {
    for (const usage of Array.from(held).reverse()) release(usage);
  };

  function usageOf(event: KeyboardEvent): number | null {
    const modifier = modifierUsage(event.code);
    return modifier ?? usageForKeyboardEvent(event);
  }

  /** A form field keeps its own keys: the serial console is a `<textarea>`. */
  function isTextEntry(node: EventTarget | null): boolean {
    const element = (node as HTMLElement | null) ?? null;
    if (element === null || typeof element.tagName !== 'string') return false;
    const tag = element.tagName.toUpperCase();
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      element.isContentEditable === true
    );
  }

  const onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (isTextEntry(keyboardEvent.target)) return;
    const usage = usageOf(keyboardEvent);
    if (usage === null) return;
    press(usage);
  };

  const onKeyUp = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const usage = usageOf(keyboardEvent);
    if (usage === null) return;
    release(usage);
  };

  /** A modifier must never stay down because the tab lost the focus. */
  const onBlur = (): void => releaseAll();

  const onStopped = (): void => detach();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);
  emulator.add_listener?.('emulator-stopped', onStopped);

  let detached = false;
  function detach(): void {
    if (detached) return;
    detached = true;
    target?.removeEventListener('keydown', onKeyDown);
    target?.removeEventListener('keyup', onKeyUp);
    target?.removeEventListener('blur', onBlur);
    emulator.remove_listener?.('emulator-stopped', onStopped);
    releaseAll();
  }
  return detach;
}
