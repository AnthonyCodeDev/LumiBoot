import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen as testingScreen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getSystemById } from '@lumiboot/catalog';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { SessionScreen } from './SessionScreen';

const system = getSystemById('debian-12-i386')!;

function makeSession(state: SessionSnapshot['state'], phase?: string): SessionSnapshot {
  return {
    id: 'session-pointer-lock',
    systemId: system.id,
    providerId: 'v86',
    state,
    ...(phase === undefined ? {} : { phase }),
  };
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

  it('shows a released indicator, then captured when the screen is pressed', () => {
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

    // The provider injects the screen after mount; it carries the display contract only.
    const container = consoleRef.current;
    expect(container).not.toBeNull();
    const screen = document.createElement('div');
    screen.setAttribute('data-vm-display', 'screen');
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

  it('shows no indicator while the session is not running', () => {
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

describe('SessionScreen — voile de boot et note de preuve tardive', () => {
  it('keeps the 5 s veil bounded and then leaves the console visible', () => {
    vi.useFakeTimers();
    try {
      const consoleRef = { current: null as HTMLDivElement | null };
      const { container } = render(
        <SessionScreen
          session={makeSession('booting')}
          system={system}
          consoleRef={consoleRef}
          onStop={() => undefined}
          onRestart={() => undefined}
        />,
      );

      // Veil on mount, still there at 4 999 ms…
      expect(container.querySelector('.status-overlay')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(4_999);
      });
      expect(container.querySelector('.status-overlay')).not.toBeNull();

      // …gone at 5 000 ms, with the console still mounted: no remount, live VM.
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(container.querySelector('.status-overlay')).toBeNull();
      expect(container.querySelector('.session-console')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the non-blocking note only while booting after a diagnostic timeout', () => {
    const consoleRef = { current: null as HTMLDivElement | null };
    const { container } = render(
      <SessionScreen
        session={makeSession('booting', 'boot-timeout')}
        system={system}
        consoleRef={consoleRef}
        onStop={() => undefined}
        onRestart={() => undefined}
      />,
    );

    const note = testingScreen.getByTestId('boot-timeout-note');
    expect(note.tagName).toBe('P');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toContain('not verified');
    // Under the viewport, never an overlay: the console stays clickable.
    expect(container.querySelector('.session-viewport .session-boot-note')).toBeNull();
    expect(container.querySelector('.session-screen > .session-boot-note')).toBe(note);
  });

  it('shows no late-proof note in another phase or another state', () => {
    const cases: { session: SessionSnapshot; render: string }[] = [
      { session: makeSession('booting', 'booting'), render: 'booting' },
      { session: makeSession('booting'), render: 'booting without phase' },
      { session: makeSession('running', 'boot-timeout'), render: 'running' },
      { session: makeSession('stopped', 'boot-timeout'), render: 'stopped' },
    ];

    for (const { session, render: label } of cases) {
      const consoleRef = { current: null as HTMLDivElement | null };
      const { unmount } = render(
        <SessionScreen
          session={session}
          system={system}
          consoleRef={consoleRef}
          onStop={() => undefined}
          onRestart={() => undefined}
        />,
      );
      expect(testingScreen.queryByTestId('boot-timeout-note'), label).toBeNull();
      unmount();
    }
  });
});

describe('SessionScreen — visibilité des logs', () => {
  function renderSession(systemId: string) {
    const system = getSystemById(systemId)!;
    const consoleRef = { current: null as HTMLDivElement | null };
    const view = render(
      <SessionScreen
        session={{
          id: `session-${systemId}`,
          systemId,
          providerId: 'v86',
          state: 'running',
        }}
        system={system}
        consoleRef={consoleRef}
        onStop={() => undefined}
        onRestart={() => undefined}
      />,
    );
    return {
      unmount: view.unmount,
      console: view.container.querySelector<HTMLElement>('.session-console'),
      logs: testingScreen.getByRole('button', { name: 'Logs' }),
    };
  }

  function expectOpen(console: HTMLElement | null, logs: HTMLElement): void {
    // `logs-hidden` is what really hides `textarea.v86-serial`: the panel is open.
    expect(console?.classList.contains('logs-hidden')).toBe(false);
    expect(logs.getAttribute('aria-pressed')).toBe('true');
  }

  function expectClosed(console: HTMLElement | null, logs: HTMLElement): void {
    expect(console?.classList.contains('logs-hidden')).toBe(true);
    expect(logs.getAttribute('aria-pressed')).toBe('false');
  }

  it('keeps the logs collapsed by default for every guest type', () => {
    for (const systemId of [
      'alpine-3-24-x86-64',
      'ubuntu-18-i386',
      'debian-12-i386',
      'ubuntu-18-i386-xfce',
      'windows-10-x86',
    ]) {
      const { console, logs, unmount } = renderSession(systemId);
      expectClosed(console, logs);
      unmount();
    }
  });

  it('keeps the "Logs" button as the explicit visibility toggle', async () => {
    const user = userEvent.setup();
    const { console, logs } = renderSession('ubuntu-18-i386');
    expectClosed(console, logs);

    await user.click(logs);
    expectOpen(console, logs);

    await user.click(logs);
    expectClosed(console, logs);
  });
});
