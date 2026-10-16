/**
 * Adaptateur de console. Il isole totalement le rendu v86 (VGA + série) du
 * reste de l'application : le composant React ne fait que fournir un conteneur,
 * et n'importe jamais `v86`.
 *
 * v86 attend une structure DOM précise pour l'écran : un enfant `<div>` (mode
 * texte) suivi d'un `<canvas>` (mode graphique). On la fabrique ici, avec un
 * `<textarea>` réel monté et focalisable pour la console série.
 *
 * L'écran porte le marqueur provider-agnostique `data-vm-display="screen"`
 * (contrat `VMDisplay`) : l'UI générique retrouve la cible du rendu, du Pointer
 * Lock et du plein écran sans connaître v86. Les classes `.v86-*` restent pour
 * le style de l'émulateur et les tests E2E.
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
  /** Conteneur transmis à `V86Options.screen.container`. */
  readonly screenContainer: HTMLElement;
  /** Conteneur transmis à `V86Options.serial_console.container`. */
  readonly serialTextarea: HTMLTextAreaElement;
}

export interface V86ConsoleAdapter {
  /** Élément écran (`.v86-screen`), exposé pour le scrollback molette. */
  readonly screen: HTMLElement | null;
  /** Contrat d'affichage implémenté (marqueurs `data-vm-display`). */
  readonly display?: VMDisplay;
  /** Contrat d'entrée implémenté (stratégie de capture du pointeur). */
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
    // Cible réelle du rendu/pointer/fullscreen, indépendante du moteur.
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
    serialTextarea.setAttribute('aria-label', 'Console série du système invité');

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
