import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_VM_DISPLAY } from '@lumiboot/vm-core';
import {
  attachPointerLockCapture,
  DEFAULT_SCREEN_SELECTOR,
  isPointerLockSupported,
  POINTER_LOCKED_CLASS,
  type PointerLockCaptureHandle,
} from './pointer-lock';

/**
 * Mock Pointer Lock pour jsdom (qui ne l'implémente pas). Il reproduit le
 * contrat réel observé : `requestPointerLock()` verrouille l'élément demandé,
 * `document.pointerLockElement` reflète le verrou, `exitPointerLock()` le
 * libère, et chaque transition émet `pointerlockchange` sur `document`.
 */
interface PointerLockMock {
  requestCalls: number;
  exitCalls: number;
  /** Force une libération externe (Échap natif) + événement `pointerlockchange`. */
  releaseExternally(): void;
  restore(): void;
}

function installPointerLock(options: { rejectRequest?: boolean } = {}): PointerLockMock {
  const doc = document as Document & { pointerLockElement: Element | null };
  let locked: Element | null = null;

  const originalPointerLockElement = Object.getOwnPropertyDescriptor(doc, 'pointerLockElement');
  const originalExit = Object.getOwnPropertyDescriptor(doc, 'exitPointerLock');
  const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestPointerLock');

  Object.defineProperty(doc, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });

  const exitPointerLock = vi.fn(() => {
    if (locked === null) return;
    locked = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  });
  Object.defineProperty(doc, 'exitPointerLock', {
    configurable: true,
    writable: true,
    value: exitPointerLock,
  });

  const applyLock = (element: Element): Promise<void> => {
    locked = element;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  const requestPointerLock = vi.fn(function (this: Element): Promise<void> {
    if (options.rejectRequest) return Promise.reject(new Error('refusé par le navigateur'));
    return applyLock(this);
  });
  Object.defineProperty(Element.prototype, 'requestPointerLock', {
    configurable: true,
    writable: true,
    value: requestPointerLock,
  });

  const mock: PointerLockMock = {
    get requestCalls() {
      return requestPointerLock.mock.calls.length;
    },
    get exitCalls() {
      return exitPointerLock.mock.calls.length;
    },
    releaseExternally() {
      locked = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
    restore() {
      if (originalPointerLockElement) {
        Object.defineProperty(doc, 'pointerLockElement', originalPointerLockElement);
      } else {
        delete (doc as unknown as Record<string, unknown>)['pointerLockElement'];
      }
      if (originalExit) {
        Object.defineProperty(doc, 'exitPointerLock', originalExit);
      } else {
        delete (doc as unknown as Record<string, unknown>)['exitPointerLock'];
      }
      if (originalRequest) {
        Object.defineProperty(Element.prototype, 'requestPointerLock', originalRequest);
      } else {
        delete (Element.prototype as unknown as Record<string, unknown>)['requestPointerLock'];
      }
    },
  };
  return mock;
}

interface Fixture {
  container: HTMLDivElement;
  screen: HTMLDivElement;
  canvas: HTMLCanvasElement;
  serial: HTMLTextAreaElement;
}

/**
 * Écran FACTICE conforme au seul contrat d'affichage provider-agnostique :
 * marqueur `data-vm-display="screen"`, AUCUNE classe `.v86-screen`. Une capture
 * réussie sur cet élément prouve que l'UI ne dépend pas du moteur v86.
 */
function makeFixture(): Fixture {
  const container = document.createElement('div');
  container.className = 'session-console';
  const screen = document.createElement('div');
  screen.setAttribute('data-vm-display', 'screen');
  const canvas = document.createElement('canvas');
  canvas.className = 'v86-screen-canvas';
  screen.append(canvas);
  const serial = document.createElement('textarea');
  serial.className = 'v86-serial';
  container.append(screen, serial);
  document.body.append(container);
  return { container, screen, canvas, serial };
}

function pointerDownOn(target: Element, button = 0): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }));
}

describe('pointer-lock — orchestration Pointer Lock', () => {
  let mock: PointerLockMock | null = null;

  afterEach(() => {
    mock?.restore();
    mock = null;
    document.body.innerHTML = '';
  });

  it('n’est pas supporté quand le Pointer Lock est absent', () => {
    expect(isPointerLockSupported(document)).toBe(false);
  });

  it('capture dès l’appui dans l’écran, avant le relâchement', () => {
    mock = installPointerLock();
    expect(isPointerLockSupported(document)).toBe(true);

    const { container, screen, canvas } = makeFixture();
    const states: boolean[] = [];
    const handle = attachPointerLockCapture({
      container,
      onCaptureChange: (captured) => states.push(captured),
    });

    // Avant tout clic : pas de verrou, pas de curseur masqué.
    expect(document.pointerLockElement).toBeNull();
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);

    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBe(screen);
    expect(handle.isCaptured()).toBe(true);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(true);
    expect(states).toEqual([true]);

    handle.dispose();
  });

  it('ignore les clics hors écran (logs, conteneur) : jamais de capture parasite', () => {
    mock = installPointerLock();
    const { container, serial } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    pointerDownOn(container);
    pointerDownOn(serial);

    expect(document.pointerLockElement).toBeNull();
    expect(mock.requestCalls).toBe(0);
    expect(onError).not.toHaveBeenCalled();

    handle.dispose();
  });

  it('libère au pointerlockchange (Échap) et restaure le curseur, puis recapture', () => {
    mock = installPointerLock();
    const { container, screen, canvas } = makeFixture();
    const states: boolean[] = [];
    const handle = attachPointerLockCapture({
      container,
      onCaptureChange: (captured) => states.push(captured),
    });

    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    // Échap est géré nativement par le navigateur : il libère et émet l'événement.
    mock.releaseExternally();

    expect(document.pointerLockElement).toBeNull();
    expect(handle.isCaptured()).toBe(false);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);
    expect(states).toEqual([true, false]);

    // Nouveau clic explicite => recapture.
    pointerDownOn(screen);
    expect(handle.isCaptured()).toBe(true);
    expect(document.pointerLockElement).toBe(screen);

    handle.dispose();
  });

  it('ne redemande pas la capture si l’écran est déjà verrouillé (pas de doublon)', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });

    pointerDownOn(canvas);
    pointerDownOn(canvas);
    pointerDownOn(canvas);

    expect(mock.requestCalls).toBe(1);
    handle.dispose();
  });

  it('remonte une erreur si la demande est refusée et ne masque pas le curseur', async () => {
    mock = installPointerLock({ rejectRequest: true });
    const { container, screen, canvas } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    pointerDownOn(canvas);

    // Rejet asynchrone + repli sans option : on laisse les micro-tâches finir.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalled();
    expect(handle.isCaptured()).toBe(false);
    expect(screen.classList.contains(POINTER_LOCKED_CLASS)).toBe(false);
    handle.dispose();
  });

  it('remonte l’événement pointerlockerror du navigateur', () => {
    mock = installPointerLock();
    const { container } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    document.dispatchEvent(new Event('pointerlockerror'));

    expect(onError).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('libère le verrou et détache les écouteurs au dispose', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });

    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    handle.dispose();

    expect(mock.exitCalls).toBeGreaterThan(0);
    expect(document.pointerLockElement).toBeNull();
    expect(handle.isCaptured()).toBe(false);

    // Après dispose : plus aucun écouteur actif.
    const callsAfterDispose = mock.requestCalls;
    pointerDownOn(canvas);
    expect(mock.requestCalls).toBe(callsAfterDispose);
  });

  it('libère quand l’onglet devient invisible', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(handle.isCaptured()).toBe(false);
    expect(mock.exitCalls).toBeGreaterThan(0);

    if (original) Object.defineProperty(document, 'visibilityState', original);
    else delete (document as unknown as Record<string, unknown>)['visibilityState'];
    handle.dispose();
  });

  it('libère quand la fenêtre perd le focus', () => {
    mock = installPointerLock();
    const { container, canvas } = makeFixture();
    const handle: PointerLockCaptureHandle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);
    expect(handle.isCaptured()).toBe(true);

    window.dispatchEvent(new Event('blur'));

    expect(handle.isCaptured()).toBe(false);
    expect(mock.exitCalls).toBeGreaterThan(0);
    handle.dispose();
  });

  it('expose un sélecteur d’écran provider-agnostique (contrat standard)', () => {
    expect(DEFAULT_SCREEN_SELECTOR).toBe(STANDARD_VM_DISPLAY.screenSelector);
    expect(DEFAULT_SCREEN_SELECTOR).toBe('[data-vm-display="screen"]');
    // Plus aucune trace de sélecteur spécifique à v86 dans l'UI générique.
    expect(DEFAULT_SCREEN_SELECTOR).not.toContain('v86');
  });

  it('ignore un écran purement v86 dépourvu du marqueur d’affichage standard', () => {
    mock = installPointerLock();
    const container = document.createElement('div');
    container.className = 'session-console';
    // Écran legacy : classe v86 uniquement, aucun marqueur de contrat.
    const legacy = document.createElement('div');
    legacy.className = 'v86-screen';
    const canvas = document.createElement('canvas');
    legacy.append(canvas);
    container.append(legacy);
    document.body.append(container);

    const handle = attachPointerLockCapture({ container });
    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBeNull();
    expect(mock.requestCalls).toBe(0);
    handle.dispose();
  });

  it('accepte un contrat d’affichage explicite fourni par un futur moteur', () => {
    mock = installPointerLock();
    const container = document.createElement('div');
    const screen = document.createElement('div');
    screen.setAttribute('data-vm-display', 'framebuffer');
    const canvas = document.createElement('canvas');
    screen.append(canvas);
    container.append(screen);
    document.body.append(container);

    const handle = attachPointerLockCapture({
      container,
      display: {
        screenSelector: '[data-vm-display="framebuffer"]',
        textSelector: '[data-vm-display="text"]',
      },
    });
    pointerDownOn(canvas);

    expect(document.pointerLockElement).toBe(screen);
    handle.dispose();
  });
});

describe('pointer-lock — support absent', () => {
  it('ne capture pas et signale l’indisponibilité (sans écouteur posé)', () => {
    // jsdom sans mock : aucune API Pointer Lock.
    const { container, canvas } = makeFixture();
    const onError = vi.fn();
    const handle = attachPointerLockCapture({ container, onError });

    expect(handle.isSupported()).toBe(false);
    pointerDownOn(canvas);
    expect(onError).not.toHaveBeenCalled(); // le clic est simplement ignoré

    handle.requestCapture();
    expect(onError).toHaveBeenCalledTimes(1);

    handle.dispose();
  });
});
