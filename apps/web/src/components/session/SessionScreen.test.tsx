import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen as testingScreen } from '@testing-library/react';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { SessionScreen } from './SessionScreen';

const system = getSystemById('debian-12-i386')!;

function makeSession(state: SessionSnapshot['state']): SessionSnapshot {
  return { id: 'session-pointer-lock', systemId: system.id, providerId: 'v86', state };
}

function installPointerLock(): { restore: () => void } {
  const doc = document as Document & { pointerLockElement: Element | null };
  let locked: Element | null = null;
  const originalElement = Object.getOwnPropertyDescriptor(doc, 'pointerLockElement');
  const originalExit = Object.getOwnPropertyDescriptor(doc, 'exitPointerLock');
  const originalRequest = Object.getOwnPropertyDescriptor(Element.prototype, 'requestPointerLock');

  Object.defineProperty(doc, 'pointerLockElement', {
    configurable: true,
    get: () => locked,
  });
  Object.defineProperty(doc, 'exitPointerLock', {
    configurable: true,
    value: vi.fn(() => {
      if (locked === null) return;
      locked = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    }),
  });
  const applyLock = (element: Element): Promise<void> => {
    locked = element;
    doc.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  Object.defineProperty(Element.prototype, 'requestPointerLock', {
    configurable: true,
    writable: true,
    value: function (this: Element) {
      return applyLock(this);
    },
  });

  return {
    restore() {
      if (originalElement) Object.defineProperty(doc, 'pointerLockElement', originalElement);
      else delete (doc as unknown as Record<string, unknown>)['pointerLockElement'];
      if (originalExit) Object.defineProperty(doc, 'exitPointerLock', originalExit);
      else delete (doc as unknown as Record<string, unknown>)['exitPointerLock'];
      if (originalRequest)
        Object.defineProperty(Element.prototype, 'requestPointerLock', originalRequest);
      else delete (Element.prototype as unknown as Record<string, unknown>)['requestPointerLock'];
    },
  };
}

describe('SessionScreen — indicateur de capture souris', () => {
  let mock: { restore: () => void } | null = null;

  beforeEach(() => {
    mock = installPointerLock();
  });

  afterEach(() => {
    mock?.restore();
    mock = null;
  });

  it('affiche un indicateur released puis captured dès l’appui dans l’écran', () => {
    const consoleRef = { current: null as HTMLDivElement | null };
    render(
      <SessionScreen
        session={makeSession('running')}
        system={system}
        consoleRef={consoleRef}
        onStop={() => undefined}
        onRestart={() => undefined}
      />,
    );

    // Le provider injecte l'écran APRÈS le montage, dans le conteneur de console.
    const container = consoleRef.current;
    expect(container).not.toBeNull();
    const screen = document.createElement('div');
    screen.className = 'v86-screen';
    const canvas = document.createElement('canvas');
    screen.append(canvas);
    container!.append(screen);

    const hint = testingScreen.getByTestId('pointer-lock-hint');
    expect(hint.getAttribute('data-state')).toBe('released');

    act(() => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });

    expect(hint.getAttribute('data-state')).toBe('captured');
    expect(screen.classList.contains('is-pointer-locked')).toBe(true);
  });

  it('ne montre aucun indicateur tant que la session n’est pas active', () => {
    const consoleRef = { current: null as HTMLDivElement | null };
    render(
      <SessionScreen
        session={makeSession('booting')}
        system={system}
        consoleRef={consoleRef}
        onStop={() => undefined}
        onRestart={() => undefined}
      />,
    );

    expect(testingScreen.queryByTestId('pointer-lock-hint')).toBeNull();
  });
});
