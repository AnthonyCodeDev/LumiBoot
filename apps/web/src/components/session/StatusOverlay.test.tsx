import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { StatusOverlay } from './StatusOverlay';

const system = getSystemById('debian-12-i386')!;

function makeSession(state: SessionSnapshot['state'], phase?: string): SessionSnapshot {
  return {
    id: 'session-test',
    systemId: system.id,
    providerId: 'v86',
    state,
    ...(phase === undefined ? {} : { phase }),
  };
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

function serialTextarea(consoleRef: { current: HTMLDivElement }): HTMLTextAreaElement {
  return consoleRef.current.querySelector<HTMLTextAreaElement>('textarea.v86-serial')!;
}

function readLines(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('.session-logs-line')).map((el) => el.textContent);
}

function renderOverlay(session: SessionSnapshot, options: { serialText?: string } = {}) {
  const consoleRef = makeConsoleRef(options.serialText);
  const view = render(<StatusOverlay session={session} system={system} consoleRef={consoleRef} />);
  return { consoleRef, ...view };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('StatusOverlay — boot log', () => {
  it('ignores blank serial lines: whitespace only keeps the veil and the fallback', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderOverlay(makeSession('booting'), {
        serialText: '\n   \n\t\r\n',
      });

      advance(500);

      expect(container.querySelector('.status-overlay')).not.toBeNull();
      expect(readLines(container)).toEqual(['Starting the system…']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a fallback line when the terminal is empty', () => {
    const { container } = renderOverlay(makeSession('booting'));
    expect(readLines(container)).toEqual(['Starting the system…']);
  });

  it('renders neither a progress bar nor the "Session running" step', () => {
    const { container } = renderOverlay(makeSession('booting'));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector('.session-steps')).toBeNull();
    expect(container.textContent).not.toContain('Session running');
  });
});

describe('StatusOverlay — loading veil until the guest actually starts', () => {
  it('keeps the veil while the serial terminal stays empty, even after 60 s', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderOverlay(makeSession('booting'), { serialText: '' });
      expect(container.querySelector('.status-overlay')).not.toBeNull();
      expect(readLines(container)).toEqual(['Starting the system…']);

      advance(60_000);
      expect(container.querySelector('.status-overlay')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the veil as soon as a non-empty serial line appears', () => {
    vi.useFakeTimers();
    try {
      const { container, consoleRef } = renderOverlay(makeSession('booting'), { serialText: '' });
      expect(container.querySelector('.status-overlay')).not.toBeNull();

      act(() => {
        serialTextarea(consoleRef).value = '\n  \nLinux version 6.1.0-18-686-pae';
      });
      advance(500);

      expect(container.querySelector('.status-overlay')).toBeNull();
      expect(container.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the veil on the disk-boot and guest-ready phases, without any log', () => {
    for (const phase of ['disk-boot', 'guest-ready'] as const) {
      const { container, unmount } = renderOverlay(makeSession('booting', phase));
      expect(container.querySelector('.status-overlay')).toBeNull();
      unmount();
    }
  });

  it('drops the veil when the phase turns to disk-boot after mount', () => {
    vi.useFakeTimers();
    try {
      const { container, consoleRef, rerender } = renderOverlay(makeSession('booting'), {
        serialText: '',
      });
      expect(container.querySelector('.status-overlay')).not.toBeNull();

      rerender(
        <StatusOverlay
          session={makeSession('booting', 'disk-boot')}
          system={system}
          consoleRef={consoleRef}
        />,
      );

      expect(container.querySelector('.status-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never brings the veil back once cleared, even if the buffer is emptied', () => {
    vi.useFakeTimers();
    try {
      const { container, consoleRef } = renderOverlay(makeSession('booting'), {
        serialText: 'SeaBIOS\nBooting from Hard Disk...',
      });
      advance(500);
      expect(container.querySelector('.status-overlay')).toBeNull();

      act(() => {
        serialTextarea(consoleRef).value = '';
      });
      advance(60_000);

      expect(container.querySelector('.status-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('always shows the stopped screen: it is not a loading screen', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderOverlay(makeSession('stopped'));
      advance(60_000);
      expect(container.querySelector('.status-overlay')).not.toBeNull();
      expect(container.textContent).toContain('System stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('always shows a real error, even after a long wait', () => {
    vi.useFakeTimers();
    try {
      const session: SessionSnapshot = {
        ...makeSession('error'),
        error: { code: 'MEDIA_REQUIRED', message: 'System media missing.' },
      };
      const { container } = renderOverlay(session);
      advance(60_000);
      expect(container.querySelector('.status-overlay[role="alert"]')).not.toBeNull();
      expect(container.textContent).toContain('System media missing.');
    } finally {
      vi.useRealTimers();
    }
  });
});
