// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  HID_MODIFIERS,
  HID_USAGE,
  KEYBOARD_USAGE_CHANNEL,
  attachUsbKeyboard,
  modifierUsage,
  usageForKeyboardEvent,
  type UsbKeyboardEmulator,
} from './usb-keyboard-adapter';

interface Harness {
  readonly emulator: UsbKeyboardEmulator;
  readonly send: ReturnType<typeof vi.fn>;
  readonly detach: () => void;
}

/** A fake runtime: `bus.send` records the `keyboard-usage` transitions. */
function harness(withBus = true): Harness {
  const send = vi.fn();
  const emulator: UsbKeyboardEmulator = {
    ...(withBus ? { bus: { send } } : {}),
    add_listener: () => undefined,
    remove_listener: () => undefined,
  };
  return { emulator, send, detach: attachUsbKeyboard(emulator) };
}

/** The `[usage, down]` transitions sent to the guest, in order. */
function transitions(send: ReturnType<typeof vi.fn>): Array<[number, boolean]> {
  return send.mock.calls.map((call) => call[1] as [number, boolean]);
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, ...init });
}

describe('HID usage mapping', () => {
  it('maps letters, digits and US punctuation from `KeyboardEvent.code`', () => {
    expect(usageForKeyboardEvent({ code: 'KeyA' })).toBe(0x04);
    expect(usageForKeyboardEvent({ code: 'KeyZ' })).toBe(0x1d);
    expect(usageForKeyboardEvent({ code: 'KeyM' })).toBe(0x10);
    expect(usageForKeyboardEvent({ code: 'Digit1' })).toBe(0x1e);
    expect(usageForKeyboardEvent({ code: 'Digit9' })).toBe(0x26);
    expect(usageForKeyboardEvent({ code: 'Digit0' })).toBe(0x27);
    expect(usageForKeyboardEvent({ code: 'Minus' })).toBe(0x2d);
    expect(usageForKeyboardEvent({ code: 'Equal' })).toBe(0x2e);
    expect(usageForKeyboardEvent({ code: 'BracketLeft' })).toBe(0x2f);
    expect(usageForKeyboardEvent({ code: 'BracketRight' })).toBe(0x30);
    expect(usageForKeyboardEvent({ code: 'Backslash' })).toBe(0x31);
    expect(usageForKeyboardEvent({ code: 'Semicolon' })).toBe(0x33);
    expect(usageForKeyboardEvent({ code: 'Quote' })).toBe(0x34);
    expect(usageForKeyboardEvent({ code: 'Backquote' })).toBe(0x35);
    expect(usageForKeyboardEvent({ code: 'Comma' })).toBe(0x36);
    expect(usageForKeyboardEvent({ code: 'Period' })).toBe(0x37);
    expect(usageForKeyboardEvent({ code: 'Slash' })).toBe(0x38);
  });

  it('maps the editing and navigation keys the brief asks for', () => {
    expect(usageForKeyboardEvent({ code: 'Enter' })).toBe(HID_USAGE.enter);
    expect(usageForKeyboardEvent({ code: 'Escape' })).toBe(HID_USAGE.escape);
    expect(usageForKeyboardEvent({ code: 'Tab' })).toBe(HID_USAGE.tab);
    expect(usageForKeyboardEvent({ code: 'Backspace' })).toBe(HID_USAGE.backspace);
    expect(usageForKeyboardEvent({ code: 'Delete' })).toBe(HID_USAGE.delete);
    expect(usageForKeyboardEvent({ code: 'Space' })).toBe(HID_USAGE.space);
    expect(usageForKeyboardEvent({ code: 'ArrowLeft' })).toBe(HID_USAGE.arrowLeft);
    expect(usageForKeyboardEvent({ code: 'ArrowRight' })).toBe(HID_USAGE.arrowRight);
    expect(usageForKeyboardEvent({ code: 'ArrowUp' })).toBe(HID_USAGE.arrowUp);
    expect(usageForKeyboardEvent({ code: 'ArrowDown' })).toBe(HID_USAGE.arrowDown);
  });

  it('maps the eight modifiers by side', () => {
    expect(modifierUsage('ControlLeft')).toBe(0xe0);
    expect(modifierUsage('ShiftLeft')).toBe(0xe1);
    expect(modifierUsage('AltLeft')).toBe(0xe2);
    expect(modifierUsage('MetaLeft')).toBe(0xe3);
    expect(modifierUsage('ControlRight')).toBe(0xe4);
    expect(modifierUsage('ShiftRight')).toBe(0xe5);
    expect(modifierUsage('AltRight')).toBe(0xe6);
    expect(modifierUsage('MetaRight')).toBe(0xe7);
    expect(modifierUsage('KeyA')).toBeNull();
    expect(Object.values(HID_MODIFIERS)).toHaveLength(8);
  });

  it('falls back to `key` for events without a `code`', () => {
    expect(usageForKeyboardEvent({ key: 'a' })).toBe(0x04);
    expect(usageForKeyboardEvent({ key: 'A' })).toBe(0x04);
    expect(usageForKeyboardEvent({ key: '0' })).toBe(0x27);
    expect(usageForKeyboardEvent({ key: '5' })).toBe(0x22);
    expect(usageForKeyboardEvent({ key: ' ' })).toBe(HID_USAGE.space);
    expect(usageForKeyboardEvent({ key: '/' })).toBe(0x38);
    expect(usageForKeyboardEvent({ key: 'Enter' })).toBe(HID_USAGE.enter);
    expect(usageForKeyboardEvent({ key: 'ArrowLeft' })).toBe(HID_USAGE.arrowLeft);
  });

  it('ignores what a US HID keyboard cannot express instead of throwing', () => {
    // A shifted symbol without a `code` is not guessed: Shift is its own event.
    expect(usageForKeyboardEvent({ key: '!' })).toBeNull();
    expect(usageForKeyboardEvent({ code: 'IntlRo', key: 'ろ' })).toBeNull();
    expect(usageForKeyboardEvent({ code: 'F21', key: 'Unidentified' })).toBeNull();
    expect(usageForKeyboardEvent({})).toBeNull();
    expect(usageForKeyboardEvent({ code: '', key: '' })).toBeNull();
  });
});

describe('attachUsbKeyboard', () => {
  it('sends a keydown then a keyup for a mapped physical key', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a' }));
    window.dispatchEvent(key('keyup', { code: 'KeyA', key: 'a' }));

    expect(send.mock.calls).toEqual([
      [KEYBOARD_USAGE_CHANNEL, [0x04, true]],
      [KEYBOARD_USAGE_CHANNEL, [0x04, false]],
    ]);
    detach();
  });

  it('maintains the modifier state around a chord (Shift+A)', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'ShiftLeft', key: 'Shift' }));
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'A' }));
    window.dispatchEvent(key('keyup', { code: 'KeyA', key: 'A' }));
    window.dispatchEvent(key('keyup', { code: 'ShiftLeft', key: 'Shift' }));

    expect(transitions(send)).toEqual([
      [0xe1, true],
      [0x04, true],
      [0x04, false],
      [0xe1, false],
    ]);
    detach();
  });

  it('keeps both sides of a modifier apart (left vs right Ctrl)', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'ControlLeft', key: 'Control' }));
    window.dispatchEvent(key('keydown', { code: 'ControlRight', key: 'Control' }));
    window.dispatchEvent(key('keyup', { code: 'ControlLeft', key: 'Control' }));

    expect(transitions(send)).toEqual([
      [0xe0, true],
      [0xe4, true],
      [0xe0, false],
    ]);
    detach();
  });

  it('does not queue a second transition for auto-repeat', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a' }));
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a', repeat: true }));
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a', repeat: true }));

    expect(transitions(send)).toEqual([[0x04, true]]);
    detach();
  });

  it('ignores an unmapped key without sending anything', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'IntlYen', key: '¥' }));
    window.dispatchEvent(key('keyup', { code: 'IntlYen', key: '¥' }));

    expect(send).not.toHaveBeenCalled();
    detach();
  });

  it('leaves the serial console textarea to the guest console', () => {
    const { send, detach } = harness();
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a' }));

    expect(send).not.toHaveBeenCalled();
    textarea.dispatchEvent(key('keyup', { code: 'KeyA', key: 'a' }));
    expect(send).not.toHaveBeenCalled();
    textarea.remove();
    detach();
  });

  it('releases everything held when the page loses the focus', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'ShiftLeft', key: 'Shift' }));
    window.dispatchEvent(key('keydown', { code: 'MetaLeft', key: 'Meta' }));
    window.dispatchEvent(key('keydown', { code: 'KeyC', key: 'c' }));
    window.dispatchEvent(new Event('blur'));

    expect(transitions(send)).toEqual([
      [0xe1, true],
      [0xe3, true],
      [0x06, true],
      // Released last-in-first-out, never a stuck modifier.
      [0x06, false],
      [0xe3, false],
      [0xe1, false],
    ]);
    detach();
  });

  it('stops sending once detached, and detaching twice is harmless', () => {
    const { send, detach } = harness();
    window.dispatchEvent(key('keydown', { code: 'ShiftLeft', key: 'Shift' }));
    detach();
    detach();
    window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a' }));

    // Only the release of the held modifier survives the detach.
    expect(transitions(send)).toEqual([
      [0xe1, true],
      [0xe1, false],
    ]);
  });

  it('is a no-op without a bus or without a browser window', () => {
    const withoutBus = harness(false);
    expect(() => {
      window.dispatchEvent(key('keydown', { code: 'KeyA', key: 'a' }));
    }).not.toThrow();
    expect(withoutBus.send).not.toHaveBeenCalled();
    withoutBus.detach();

    const send = vi.fn();
    const detach = attachUsbKeyboard({ bus: { send } }, { target: null });
    expect(() => detach()).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
