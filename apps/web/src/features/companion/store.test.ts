import { beforeEach, describe, expect, it } from 'vitest';
import { useCompanionStore } from './store';
import { clearCompanionSession, saveCompanionSession } from './persistence';
import { resolveCompanionConfig } from '../../config/runtime';
import type { FetchLike } from '../../config/load-config';

const STORAGE_KEY = 'lumiboot.companion.session';

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fetchRouter(routes: Record<string, { status: number; body: unknown }>): FetchLike {
  return (async (input: string) => {
    const url = String(input);
    for (const [suffix, route] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          json: async () => route.body,
        } as unknown as Response;
      }
    }
    throw new TypeError('Failed to fetch');
  }) as FetchLike;
}

const HEALTH_OK = { status: 200, body: { status: 'ok', version: '0.1.0', wispVersion: 1 } };

beforeEach(() => {
  localStorage.clear();
  clearCompanionSession();
  useCompanionStore.setState({
    state: 'not-running',
    token: null,
    pairingId: null,
    userCode: null,
    error: null,
  });
});

describe('useCompanionStore', () => {
  it('/health OK sans token → pairing-required (jamais connected sans preuve)', async () => {
    await useCompanionStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    const { state, token } = useCompanionStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
  });

  it('connexion réussie : pairing → approved → exchange → connected', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/request': {
        status: 201,
        body: { pairingId: 'p1', userCode: '654321', expiresAt: 'x' },
      },
      '/api/pair/status?id=p1': {
        status: 200,
        body: { status: 'approved', expiresAt: 'x' },
      },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: 'x' } },
    });
    await useCompanionStore.getState().startPairing(fetchImpl);
    expect(useCompanionStore.getState().state).toBe('pairing-required');
    expect(useCompanionStore.getState().userCode).toBe('654321');
    await useCompanionStore.getState().connect('p1', fetchImpl);
    expect(useCompanionStore.getState().state).toBe('connected');
    expect(useCompanionStore.getState().token).toBe('tok');
  });

  it('compagnon arrêté → not-running', async () => {
    await useCompanionStore.getState().refresh(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(useCompanionStore.getState().state).toBe('not-running');
  });

  it('révocation → token effacé, retour à pairing-required', async () => {
    useCompanionStore.setState({ token: 'tok', state: 'connected' });
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/session/revoke': { status: 200, body: { revoked: true } },
    });
    await useCompanionStore.getState().revoke(fetchImpl);
    expect(useCompanionStore.getState().token).toBeNull();
    expect(useCompanionStore.getState().state).toBe('pairing-required');
  });

  it('connect persiste le token (survie au rechargement)', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/status?id=p1': { status: 200, body: { status: 'approved', expiresAt: futureIso() } },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
    });
    useCompanionStore.setState({ pairingId: 'p1' });
    await useCompanionStore.getState().connect('p1', fetchImpl);
    expect(useCompanionStore.getState().state).toBe('connected');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('refresh restaure un token persisté valide → connected', async () => {
    saveCompanionSession({
      token: 'persisted',
      expiresAt: futureIso(),
      companionUrl: resolveCompanionConfig().url,
    });
    await useCompanionStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    expect(useCompanionStore.getState().state).toBe('connected');
    expect(useCompanionStore.getState().token).toBe('persisted');
  });

  it('refresh avec un token persisté expiré → pairing-required', async () => {
    saveCompanionSession({
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      companionUrl: resolveCompanionConfig().url,
    });
    await useCompanionStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    expect(useCompanionStore.getState().state).toBe('pairing-required');
    expect(useCompanionStore.getState().token).toBeNull();
  });

  it('revoke efface le stockage persisté', async () => {
    saveCompanionSession({
      token: 'tok',
      expiresAt: futureIso(),
      companionUrl: resolveCompanionConfig().url,
    });
    useCompanionStore.setState({ token: 'tok', state: 'connected' });
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/session/revoke': { status: 200, body: { revoked: true } },
    });
    await useCompanionStore.getState().revoke(fetchImpl);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
