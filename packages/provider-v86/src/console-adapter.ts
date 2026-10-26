/**
 * Console adapter. It fully isolates the v86 rendering (VGA + serial) from the
 * rest of the application: the React component only provides a container and
 * never imports `v86`.
 *
 * v86 expects a precise DOM structure for the screen: a `<div>` child (text
 * mode) followed by a `<canvas>` (graphics mode). It is built here, with a real
 * mounted and focusable `<textarea>` for the serial console.
 *
 * The screen carries the provider-agnostic marker `data-vm-display="screen"`
 * (`VMDisplay` contract): the generic UI finds the target of rendering, Pointer
 * Lock and fullscreen without knowing about v86. The `.v86-*` classes remain for
 * the emulator styling and the E2E tests.
 */
import {
  STANDARD_VM_DISPLAY,
  STANDARD_VM_INPUT,
  VM_DISPLAY_ATTRIBUTE,
  VM_DISPLAY_ROLES,
  type VMDisplay,
  type VMInput,
} from '@lumiboot/vm-core';

export interface V86ConsoleMount {
  /** Container passed to `V86Options.screen.container`. */
  readonly screenContainer: HTMLElement;
  /** Container passed to `V86Options.serial_console.container`. */
  readonly serialTextarea: HTMLTextAreaElement;
}

export interface V86ConsoleAdapter {
  /** Screen element (`.v86-screen`), exposed for the wheel scrollback. */
  readonly screen: HTMLElement | null;
  /** Implemented display contract (`data-vm-display` markers). */
  readonly display?: VMDisplay;
  /** Implemented input contract (pointer capture strategy). */
  readonly input?: VMInput;
  attach(container: HTMLElement): V86ConsoleMount;
  detach(): void;
}

export class DomConsoleAdapter implements V86ConsoleAdapter {
  readonly display: VMDisplay = STANDARD_VM_DISPLAY;
  readonly input: VMInput = STANDARD_VM_INPUT;

  #root: HTMLElement | null = null;
  #screen: HTMLElement | null = null;

  get screen(): HTMLElement | null {
    return this.#screen;
  }

  attach(container: HTMLElement): V86ConsoleMount {
    const doc = container.ownerDocument;

    const screen = doc.createElement('div');
    screen.className = 'v86-screen';
    // Real target of rendering/pointer/fullscreen, independent of the engine.
    screen.setAttribute(VM_DISPLAY_ATTRIBUTE, VM_DISPLAY_ROLES.screen);

    const textMode = doc.createElement('div');
    textMode.className = 'v86-screen-text';
    textMode.setAttribute(VM_DISPLAY_ATTRIBUTE, VM_DISPLAY_ROLES.text);
    textMode.style.whiteSpace = 'pre';
    textMode.style.font = '14px monospace';
    textMode.style.lineHeight = '14px';

    const canvas = doc.createElement('canvas');
    canvas.className = 'v86-screen-canvas';
    canvas.style.display = 'none';

    screen.append(textMode, canvas);

    const serialTextarea = doc.createElement('textarea');
    serialTextarea.className = 'v86-serial';
    serialTextarea.spellcheck = false;
    serialTextarea.autocapitalize = 'off';
    serialTextarea.autocomplete = 'off';
    serialTextarea.setAttribute('autocorrect', 'off');
    serialTextarea.setAttribute('aria-label', 'Guest system serial console');

    const root = doc.createElement('div');
    root.className = 'v86-console';
    root.append(screen, serialTextarea);
    container.append(root);

    this.#root = root;
    this.#screen = screen;
    return { screenContainer: screen, serialTextarea };
  }

  detach(): void {
    this.#root?.remove();
    this.#root = null;
    this.#screen = null;
  }
}
