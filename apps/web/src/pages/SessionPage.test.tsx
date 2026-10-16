import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { SessionSnapshot } from '@lumiboot/vm-core';
import { SessionPage } from './SessionPage';
import { useSessionsStore } from '../features/sessions/sessions.store';

/**
 * Tests de la page de session : capture UI des rejets asynchrones de
 * `boot()`/`restart()` et absence d'écrasement d'une nouvelle session. Le store
 * de sessions et l'écran de session sont remplacés par des doubles : on observe
 * uniquement la logique de la page.
 */

vi.mock('../components/session/SessionScreen', () => ({
  SessionScreen: ({
    session,
    consoleRef,
    onStop,
    onRestart,
    transitioning,
  }: {
    session: SessionSnapshot;
    consoleRef: React.RefObject<HTMLDivElement>;
    onStop: () => void;
    onRestart: () => void;
    transitioning?: boolean;
  }) => (
    <div>
      <div ref={consoleRef} data-testid="session-console" />
      <p data-testid="session-state">{session.state}</p>
      <button type="button" onClick={onStop}>
        Arrêter
      </button>
      <button type="button" onClick={onRestart} disabled={transitioning}>
        Redémarrer
      </button>
    </div>
  ),
}));

vi.mock('../features/sessions/sessions.store', async () => {
  const { create } = await import('zustand');
  const useSessionsStore = create(() => ({
    sessions: {} as Record<string, SessionSnapshot>,
    networkModes: {},
    create: vi.fn(() => 'new-session'),
    boot: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }));
  return { useSessionsStore };
});

function makeSession(state: SessionSnapshot['state']): SessionSnapshot {
  return { id: 'session-1', systemId: 'debian-12-i386', providerId: 'v86', state };
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderPage(id = 'session-1') {
  return render(
    <MemoryRouter initialEntries={[`/session/${id}`]}>
      <Routes>
        <Route path="/session/:id" element={<SessionPage />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useSessionsStore.setState({
    sessions: {},
    create: vi.fn(() => 'new-session'),
    boot: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  });
});

describe('SessionPage — capture des rejets asynchrones', () => {
  it('affiche une alerte quand le boot rejette (aucune promesse non gérée)', async () => {
    const session = makeSession('idle');
    useSessionsStore.setState({
      sessions: { [session.id]: session },
      boot: vi.fn(async () => {
        throw new Error('IndexedDB inaccessible');
      }),
    });

    renderPage();

    expect((await screen.findByRole('alert')).textContent).toContain('IndexedDB inaccessible');
  });

  it('affiche une alerte quand l’arrêt manuel rejette', async () => {
    const user = userEvent.setup();
    const session = makeSession('running');
    useSessionsStore.setState({
      sessions: { [session.id]: session },
      stop: vi.fn(async () => {
        throw new Error('Arrêt impossible');
      }),
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Arrêter' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Arrêt impossible');
  });

  it('libère la session au démontage', async () => {
    const session = makeSession('running');
    const dispose = vi.fn(async () => undefined);
    useSessionsStore.setState({ sessions: { [session.id]: session }, dispose });

    const view = renderPage();
    view.unmount();

    await waitFor(() => expect(dispose).toHaveBeenCalledWith('session-1'));
  });
});

describe('SessionPage — redémarrage', () => {
  it('crée une nouvelle session et navigue dessus', async () => {
    const user = userEvent.setup();
    const session = makeSession('running');
    const create = vi.fn(() => 'new-session');
    useSessionsStore.setState({ sessions: { [session.id]: session }, create });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Redémarrer' }));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toContain('/session/new-session'),
    );
    expect(create).toHaveBeenCalledWith('debian-12-i386');
  });

  it('un échec d’arrêt affiche l’erreur et n’écrase pas la session courante', async () => {
    const user = userEvent.setup();
    const session = makeSession('running');
    const create = vi.fn(() => 'new-session');
    useSessionsStore.setState({
      sessions: { [session.id]: session },
      create,
      stop: vi.fn(async () => {
        throw new Error('Arrêt impossible');
      }),
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: 'Redémarrer' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Arrêt impossible');
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toContain('/session/session-1');
  });
});
