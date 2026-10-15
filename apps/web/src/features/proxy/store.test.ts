import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_POLL_INTERVAL_MS, getProxyRuntimeCredentials, useProxyStore } from './store';
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
    for (const [marker, route] of Object.entries(routes)) {
      if (url.includes(marker)) {
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
const VERIFY_OK = { status: 200, body: { ok: true, expiresAt: futureIso() } };

beforeEach(() => {
  // Arrête toute surveillance résiduelle entre les tests.
  useProxyStore.getState().dismissError();
  localStorage.clear();
  clearProxySession();
  useProxyStore.setState({
    state: 'not-running',
    reachable: false,
    authenticated: false,
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
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      '/api/session/verify': VERIFY_OK,
    });
    await useProxyStore.getState().startPairing(fetchImpl);
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().userCode).toBe('654321');
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('connected');
    expect(useProxyStore.getState().token).toBe('tok');
    expect(useProxyStore.getState().authenticated).toBe(true);
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
        '/api/session/verify': VERIFY_OK,
      });
      await useProxyStore.getState().startPairing(fetchImpl);
      expect(useProxyStore.getState().state).toBe('pairing-required');
      expect(useProxyStore.getState().token).toBeNull();

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('connected');
      expect(useProxyStore.getState().token).toBe('tok');
      expect(useProxyStore.getState().authenticated).toBe(true);
      expect(useProxyStore.getState().reachable).toBe(true);
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('approbation mais verifyToken KO (401) → pairing-required, jamais connected', async () => {
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
        '/api/session/verify': { status: 401, body: { error: 'jeton invalide' } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('pairing-required');
      expect(useProxyStore.getState().token).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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

  it('connect persiste le token après vérification authentifiée', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/status?id=p1': {
        status: 200,
        body: { status: 'approved', expiresAt: futureIso() },
      },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      '/api/session/verify': VERIFY_OK,
    });
    useProxyStore.setState({ pairingId: 'p1' });
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('connected');
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('connect ne persiste PAS un token refusé par verifyToken', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/status?id=p1': {
        status: 200,
        body: { status: 'approved', expiresAt: futureIso() },
      },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      '/api/session/verify': { status: 403, body: { error: 'refusé' } },
    });
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().token).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('refresh restaure un token persisté valide (verifyToken OK) → connected', async () => {
    saveProxySession({
      token: 'persisted',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore
      .getState()
      .refresh(fetchRouter({ '/health': HEALTH_OK, '/api/session/verify': VERIFY_OK }));
    expect(useProxyStore.getState().state).toBe('connected');
    expect(useProxyStore.getState().token).toBe('persisted');
    expect(useProxyStore.getState().authenticated).toBe(true);
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

  it('/health OK mais verifyToken KO (401) → pairing-required, jeton persisté effacé', async () => {
    saveProxySession({
      token: 'stale',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': { status: 401, body: { error: 'jeton invalide' } },
      }),
    );
    const { state, token, authenticated } = useProxyStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
    expect(authenticated).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('/health OK, jeton mémoire refusé (403) → pairing-required, jamais connected', async () => {
    useProxyStore.setState({ token: 'mem', state: 'connected', authenticated: true });
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': { status: 403, body: { error: 'refusé' } },
      }),
    );
    const { state, token, authenticated } = useProxyStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
    expect(authenticated).toBe(false);
  });

  it('/health OK mais verifyToken en erreur réseau → error incertain, jamais connected', async () => {
    useProxyStore.setState({ token: 'mem', state: 'connected', authenticated: true });
    // Le routeur n'expose pas `/api/session/verify` : la vérification échoue.
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    const { state, authenticated } = useProxyStore.getState();
    expect(state).toBe('error');
    expect(authenticated).toBe(false);
  });

  it('getProxyRuntimeCredentials ne renvoie un jeton que si authentifié', () => {
    useProxyStore.setState({ token: 'tok', state: 'pairing-required', authenticated: false });
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
    useProxyStore.setState({ token: 'tok', state: 'connected', authenticated: true });
    expect(getProxyRuntimeCredentials().proxyToken).toBe('tok');
  });

  it('course : une approbation tardive d’un poll annulé est ignorée', async () => {
    vi.useFakeTimers();
    let settleStatus: ((value: Response) => void) | undefined;
    try {
      const fetchImpl = (async (input: string) => {
        const url = String(input);
        if (url.includes('/health')) {
          return { ok: true, status: 200, json: async () => HEALTH_OK.body } as unknown as Response;
        }
        if (url.includes('/api/pair/request')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ pairingId: 'p1', userCode: '654321', expiresAt: 'x' }),
          } as unknown as Response;
        }
        if (url.includes('/api/pair/status')) {
          return await new Promise<Response>((resolve) => {
            settleStatus = resolve;
          });
        }
        if (url.includes('/api/pair/exchange')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ token: 'tok', expiresAt: futureIso() }),
          } as unknown as Response;
        }
        throw new TypeError('Failed to fetch');
      }) as FetchLike;

      await useProxyStore.getState().startPairing(fetchImpl);
      // Premier tick : la requête de statut reste en attente.
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);
      // Nouvelle tentative : annule le poll précédent.
      useProxyStore.getState().dismissError();
      expect(typeof settleStatus).toBe('function');
      settleStatus?.({
        ok: true,
        status: 200,
        json: async () => ({ status: 'approved', expiresAt: 'x' }),
      } as unknown as Response);
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 2);

      expect(useProxyStore.getState().state).not.toBe('connected');
      expect(useProxyStore.getState().token).toBeNull();
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('revoke annule le poll : aucune approbation tardive ne reconnecte', async () => {
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
        '/api/session/verify': VERIFY_OK,
        '/api/session/revoke': { status: 200, body: { revoked: true } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);
      useProxyStore.setState({ token: 'tok' });
      await useProxyStore.getState().revoke(fetchImpl);

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS * 3);

      expect(useProxyStore.getState().state).not.toBe('connected');
      expect(useProxyStore.getState().token).toBeNull();
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });
});
