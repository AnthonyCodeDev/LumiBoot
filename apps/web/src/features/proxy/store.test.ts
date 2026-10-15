import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_POLL_INTERVAL_MS, useProxyStore } from './store';
import { clearProxySession, saveProxySession } from './persistence';
import { resolveProxyConfig } from '../../config/runtime';
import type { FetchLike } from '../../config/load-config';

const STORAGE_KEY = 'lumiboot.proxy.session';

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
  // Arrête toute surveillance résiduelle entre les tests.
  useProxyStore.getState().dismissError();
  localStorage.clear();
  clearProxySession();
  useProxyStore.setState({
    state: 'not-running',
    token: null,
    pairingId: null,
    userCode: null,
    error: null,
  });
});

describe('useProxyStore', () => {
  it('/health OK sans token → pairing-required (jamais connected sans preuve)', async () => {
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    const { state, token } = useProxyStore.getState();
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
    await useProxyStore.getState().startPairing(fetchImpl);
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().userCode).toBe('654321');
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('connected');
    expect(useProxyStore.getState().token).toBe('tok');
  });

  it('auto-connexion : approbation détectée par polling → connected sans connect()', async () => {
    vi.useFakeTimers();
    try {
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
        '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);
      expect(useProxyStore.getState().state).toBe('pairing-required');
      expect(useProxyStore.getState().token).toBeNull();

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('connected');
      expect(useProxyStore.getState().token).toBe('tok');
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('auto-connexion : refus depuis la console → error explicite', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fetchRouter({
        '/health': HEALTH_OK,
        '/api/pair/request': {
          status: 201,
          body: { pairingId: 'p1', userCode: '654321', expiresAt: 'x' },
        },
        '/api/pair/status?id=p1': {
          status: 200,
          body: { status: 'denied', expiresAt: 'x' },
        },
      });
      await useProxyStore.getState().startPairing(fetchImpl);

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('error');
      expect(useProxyStore.getState().error).toBe('Accès refusé depuis la console du proxy.');
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('auto-connexion : appairage expiré/introuvable (404) → error', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fetchRouter({
        '/health': HEALTH_OK,
        '/api/pair/request': {
          status: 201,
          body: { pairingId: 'p1', userCode: '654321', expiresAt: 'x' },
        },
        '/api/pair/status?id=p1': { status: 404, body: { error: 'not found' } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('error');
      expect(useProxyStore.getState().error).toMatch(/introuvable ou expirée/);
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('dismissError arrête la surveillance (plus de passage à connected)', async () => {
    vi.useFakeTimers();
    try {
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
        '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);
      useProxyStore.getState().dismissError();

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 3);

      expect(useProxyStore.getState().state).toBe('pairing-required');
      expect(useProxyStore.getState().token).toBeNull();
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('proxy réseau local arrêté → not-running', async () => {
    await useProxyStore.getState().refresh(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(useProxyStore.getState().state).toBe('not-running');
  });

  it('révocation → token effacé, retour à pairing-required', async () => {
    useProxyStore.setState({ token: 'tok', state: 'connected' });
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/session/revoke': { status: 200, body: { revoked: true } },
    });
    await useProxyStore.getState().revoke(fetchImpl);
    expect(useProxyStore.getState().token).toBeNull();
    expect(useProxyStore.getState().state).toBe('pairing-required');
  });

  it('connect persiste le token (survie au rechargement)', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/status?id=p1': { status: 200, body: { status: 'approved', expiresAt: futureIso() } },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
    });
    useProxyStore.setState({ pairingId: 'p1' });
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('connected');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('refresh restaure un token persisté valide → connected', async () => {
    saveProxySession({
      token: 'persisted',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    expect(useProxyStore.getState().state).toBe('connected');
    expect(useProxyStore.getState().token).toBe('persisted');
  });

  it('refresh avec un token persisté expiré → pairing-required', async () => {
    saveProxySession({
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().token).toBeNull();
  });

  it('revoke efface le stockage persisté', async () => {
    saveProxySession({
      token: 'tok',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    useProxyStore.setState({ token: 'tok', state: 'connected' });
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/session/revoke': { status: 200, body: { revoked: true } },
    });
    await useProxyStore.getState().revoke(fetchImpl);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
