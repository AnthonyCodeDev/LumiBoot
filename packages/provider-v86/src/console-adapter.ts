/**
 * Adaptateur de console. Il isole totalement le rendu v86 (VGA + série) du
 * reste de l'application : le composant React ne fait que fournir un conteneur,
 * et n'importe jamais `v86`.
 *
 * v86 attend une structure DOM précise pour l'écran : un enfant `<div>` (mode
 * texte) suivi d'un `<canvas>` (mode graphique). On la fabrique ici, avec un
 * `<textarea>` réel monté et focalisable pour la console série.
 */
export interface V86ConsoleMount {
  /** Conteneur transmis à `V86Options.screen.container`. */
  readonly screenContainer: HTMLElement;
  /** Conteneur transmis à `V86Options.serial_console.container`. */
  readonly serialTextarea: HTMLTextAreaElement;
}

export interface V86ConsoleAdapter {
  attach(container: HTMLElement): V86ConsoleMount;
  detach(): void;
}

export class DomConsoleAdapter implements V86ConsoleAdapter {
  #root: HTMLElement | null = null;

  attach(container: HTMLElement): V86ConsoleMount {
    const doc = container.ownerDocument;

    const screen = doc.createElement('div');
    screen.className = 'v86-screen';

    const textMode = doc.createElement('div');
    textMode.className = 'v86-screen-text';
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
    serialTextarea.setAttribute('aria-label', 'Console série du système invité');

    const root = doc.createElement('div');
    root.className = 'v86-console';
    root.append(screen, serialTextarea);
    container.append(root);

    this.#root = root;
    return { screenContainer: screen, serialTextarea };
  }

  detach(): void {
    this.#root?.remove();
    this.#root = null;
  }
}
