import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { StatusOverlay } from './StatusOverlay';

const system = getSystemById('debian-12-i386')!;

function makeSession(state: SessionSnapshot['state']): SessionSnapshot {
  return { id: 'session-test', systemId: system.id, providerId: 'v86', state };
}

/** Fake container with an optional `textarea.v86-serial`. */
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

describe('StatusOverlay — boot log', () => {
  it('shows the last 3 non-empty lines of the serial terminal (polling)', () => {
    vi.useFakeTimers();
    try {
      const consoleRef = makeConsoleRef();
      const { container } = render(
        <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
      );

      // The terminal fills up after mount: polling must pick it up.
      const textarea = document.createElement('textarea');
      textarea.className = 'v86-serial';
      textarea.value = 'boot\n\nline 1\nline 2\nline 3\nline 4';
      consoleRef.current.appendChild(textarea);

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(readLines(container)).toEqual(['line 2', 'line 3', 'line 4']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a fallback line when the terminal is empty', () => {
    const consoleRef = makeConsoleRef();
    const { container } = render(
      <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
    );
    expect(readLines(container)).toEqual(['Starting the system…']);
  });

  it('renders neither a progress bar nor the "Session running" step', () => {
    const consoleRef = makeConsoleRef();
    const { container } = render(
      <StatusOverlay session={makeSession('booting')} system={system} consoleRef={consoleRef} />,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('.session-steps')).toBeNull();
    expect(container.textContent).not.toContain('Session running');
  });
});
