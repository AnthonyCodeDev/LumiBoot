import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { StatusOverlay } from './StatusOverlay';

const system = getSystemById('debian-12-i386')!;

function makeSession(state: SessionSnapshot['state']): SessionSnapshot {
  return { id: 'session-test', systemId: system.id, providerId: 'v86', state };
}

/** Conteneur factice imitant `.session-console` (avec son `textarea.v86-serial`). */
function makeConsoleRef(serialText?: string): { current: HTMLDivElement } {
  const container = document.createElement('div');
  if (serialText !== undefined) {
    const textarea = document.createElement('textarea');
    textarea.className = 'v86-serial';
    textarea.value = serialText;
    container.appendChild(textarea);
  }
  return { current: container };
}

function readLines(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.session-logs-line')).map((el) => el.textContent);
}

describe('StatusOverlay — journal de démarrage', () => {
  it('affiche les 3 dernières lignes non vides du terminal série (polling)', () => {
    vi.useFakeTimers();
    try {
      const consoleRef = makeConsoleRef();
      const { container } = render(
        <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
      );

      // Le terminal se remplit après le montage : le polling doit le reprendre.
      const textarea = document.createElement('textarea');
      textarea.className = 'v86-serial';
      textarea.value = 'amorçage\n\nligne 1\nligne 2\nligne 3\nligne 4';
      consoleRef.current.appendChild(textarea);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(readLines(container)).toEqual(['ligne 2', 'ligne 3', 'ligne 4']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('affiche une ligne de repli quand le terminal est vide', () => {
    const consoleRef = makeConsoleRef();
    const { container } = render(
      <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
    );
    expect(readLines(container)).toEqual(['Démarrage du système…']);
  });

  it("ne rend ni barre de progression ni l'étape « Session active »", () => {
    const consoleRef = makeConsoleRef();
    const { container } = render(
      <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('.session-steps')).toBeNull();
    expect(container.textContent).not.toContain('Session active');
  });
});
