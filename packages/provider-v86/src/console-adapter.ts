/** v86 requires a `<div>` child followed by a `<canvas>` for the screen. */
import {
  STANDARD_VM_DISPLAY,
  STANDARD_VM_INPUT,
  VM_DISPLAY_ATTRIBUTE,
  VM_DISPLAY_ROLES,
  type VMDisplay,
  type VMInput,
} from '@lumiboot/vm-core';

export interface V86ConsoleMount {
  readonly screenContainer: HTMLElement;
  readonly serialTextarea: HTMLTextAreaElement;
}

export interface V86ConsoleAdapter {
  readonly screen: HTMLElement | null;
  readonly display?: VMDisplay;
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
    // Generic target for rendering, pointer and fullscreen.
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
