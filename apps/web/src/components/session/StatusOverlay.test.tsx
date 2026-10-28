import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { BOOT_VEIL_MS, StatusOverlay } from './StatusOverlay';

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

function renderOverlay(session: SessionSnapshot): { container: HTMLElement } {
  const consoleRef = makeConsoleRef();
  const { container } = render(
    <StatusOverlay session={session} system={system} consoleRef={consoleRef} />,
  );
  return { container };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
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

describe('StatusOverlay — 5 s boot veil', () => {
  it('veils a booting session until 4 999 ms, then renders nothing at 5 000 ms', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderOverlay(makeSession('booting'));
      expect(container.querySelector('.status-overlay')).not.toBeNull();
      expect(readLines(container)).toEqual(['Starting the system…']);

      advance(BOOT_VEIL_MS - 1);
      // Still inside the window: the veil holds.
      expect(container.querySelector('.status-overlay')).not.toBeNull();

      advance(1);
      // Window closed: the real UI (console or screen) is shown instead.
      expect(container.querySelector('.status-overlay')).toBeNull();
      expect(container.textContent).toBe('');

      // The veil never comes back, even if the boot is still not finished.
      advance(60_000);
      expect(container.querySelector('.status-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('veils preparing and downloading the same fixed 5 s', () => {
    vi.useFakeTimers();
    try {
      for (const state of ['preparing', 'downloading'] as const) {
        const { container } = renderOverlay(makeSession(state));
        expect(container.querySelector('.status-overlay')).not.toBeNull();
        advance(BOOT_VEIL_MS);
        expect(container.querySelector('.status-overlay')).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('always shows the stopped screen: it is not a loading screen', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderOverlay(makeSession('stopped'));
      advance(BOOT_VEIL_MS);
      expect(container.querySelector('.status-overlay')).not.toBeNull();
      expect(container.textContent).toContain('System stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('always shows a real error, even after the veil window', () => {
    vi.useFakeTimers();
    try {
      const session: SessionSnapshot = {
        ...makeSession('error'),
        error: { code: 'MEDIA_REQUIRED', message: 'System media missing.' },
      };
      const { container } = renderOverlay(session);
      advance(BOOT_VEIL_MS);
      advance(60_000);
      expect(container.querySelector('.status-overlay[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain('System media missing.');
    } finally {
      vi.useRealTimers();
    }
  });
});
