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
  useProxyStore.getState().dismissError();
  localStorage.clear();
  sessionStorage.clear();
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
  it('/health OK without a token → pairing-required (never connected without proof)', async () => {
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    const { state, token } = useProxyStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
  });

  it('successful connection: pairing → approved → exchange → connected', async () => {
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

  it('auto-connect: approval detected by polling → connected without connect()', async () => {
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

  it('refresh does not interrupt an active pairing', async () => {
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
      await useProxyStore.getState().refresh(fetchImpl);
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);
      expect(useProxyStore.getState().state).toBe('connected');
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('approved but verifyToken KO (401) → pairing-required, never connected', async () => {
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
        '/api/session/verify': { status: 401, body: { error: 'invalid token' } },
      });
      await useProxyStore.getState().startPairing(fetchImpl);

      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);

      expect(useProxyStore.getState().state).toBe('pairing-required');
      expect(useProxyStore.getState().token).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('auto-connect: refusal from the console → explicit error', async () => {
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
      expect(useProxyStore.getState().error).toBe('Access refused from the proxy console.');
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('auto-connect: expired/unknown pairing (404) → error', async () => {
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
      expect(useProxyStore.getState().error).toMatch(/not found or expired/);
    } finally {
      useProxyStore.getState().dismissError();
      vi.useRealTimers();
    }
  });

  it('dismissError stops the watch (no more switch to connected)', async () => {
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

  it('local network proxy stopped → not-running', async () => {
    await useProxyStore.getState().refresh(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(useProxyStore.getState().state).toBe('not-running');
  });

  it('revocation → token cleared, back to pairing-required', async () => {
    useProxyStore.setState({ token: 'tok', state: 'connected' });
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/session/revoke': { status: 200, body: { revoked: true } },
    });
    await useProxyStore.getState().revoke(fetchImpl);
    expect(useProxyStore.getState().token).toBeNull();
    expect(useProxyStore.getState().state).toBe('pairing-required');
  });

  it('connect persists the token after authenticated verification', async () => {
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
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('connect does NOT persist a token refused by verifyToken', async () => {
    const fetchImpl = fetchRouter({
      '/health': HEALTH_OK,
      '/api/pair/status?id=p1': {
        status: 200,
        body: { status: 'approved', expiresAt: futureIso() },
      },
      '/api/pair/exchange': { status: 200, body: { token: 'tok', expiresAt: futureIso() } },
      '/api/session/verify': { status: 403, body: { error: 'refused' } },
    });
    await useProxyStore.getState().connect('p1', fetchImpl);
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().token).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('refresh restores a valid persisted token (verifyToken OK) → connected', async () => {
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

  it('refresh persists the renewed expiry returned by verifyToken', async () => {
    saveProxySession({
      token: 'persisted',
      expiresAt: futureIso(10_000),
      proxyUrl: resolveProxyConfig().url,
    });
    const renewed = futureIso(120_000);
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': { status: 200, body: { ok: true, expiresAt: renewed } },
      }),
    );
    expect(useProxyStore.getState().state).toBe('connected');
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as {
      expiresAt?: string;
    };
    expect(stored.expiresAt).toBe(renewed);
  });

  it('refresh does not persist a renewed expiry that is already past', async () => {
    useProxyStore.setState({ token: 'mem' });
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': {
          status: 200,
          body: { ok: true, expiresAt: new Date(Date.now() - 1000).toISOString() },
        },
      }),
    );
    expect(useProxyStore.getState().state).toBe('connected');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('refresh with an expired persisted token → pairing-required', async () => {
    saveProxySession({
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().token).toBeNull();
  });

  it('revoke clears the persisted storage', async () => {
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
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('disconnects locally before the revocation response arrives', async () => {
    saveProxySession({
      token: 'tok',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    useProxyStore.setState({ token: 'tok', state: 'connected', authenticated: true });
    let releaseRevoke: ((response: Response) => void) | undefined;
    const fetchImpl: FetchLike = async (input) => {
      if (String(input).includes('/api/session/revoke')) {
        return new Promise<Response>((resolve) => {
          releaseRevoke = resolve;
        });
      }
      return { ok: true, status: 200, json: async () => HEALTH_OK.body } as Response;
    };
    const revocation = useProxyStore.getState().revoke(fetchImpl);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
    expect(useProxyStore.getState().state).toBe('pairing-required');
    releaseRevoke?.({ ok: true, status: 200, json: async () => ({ revoked: true }) } as Response);
    await revocation;
  });

  it('a failed revocation can be retried', async () => {
    saveProxySession({
      token: 'tok',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    useProxyStore.setState({ token: 'tok', state: 'connected', authenticated: true });
    const revokedTokens: unknown[] = [];
    const failing: FetchLike = async (_input, init) => {
      revokedTokens.push(JSON.parse(String(init?.body)).token);
      throw new TypeError('Failed to fetch');
    };

    await useProxyStore.getState().revoke(failing);

    expect(useProxyStore.getState().state).toBe('error');
    expect(useProxyStore.getState().token).toBeNull();
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    // The token is only kept in memory, so a second attempt can still revoke it.
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/session/revoke')) {
        revokedTokens.push(JSON.parse(String(init?.body)).token);
        return { ok: true, status: 200, json: async () => ({ revoked: true }) } as Response;
      }
      return { ok: true, status: 200, json: async () => HEALTH_OK.body } as Response;
    }) as FetchLike;

    await useProxyStore.getState().revoke(fetchImpl);

    expect(revokedTokens).toEqual(['tok', 'tok']);
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().token).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('/health OK but verifyToken KO (401) → pairing-required, persisted token cleared', async () => {
    saveProxySession({
      token: 'stale',
      expiresAt: futureIso(),
      proxyUrl: resolveProxyConfig().url,
    });
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': { status: 401, body: { error: 'invalid token' } },
      }),
    );
    const { state, token, authenticated } = useProxyStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
    expect(authenticated).toBe(false);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('/health OK, in-memory token refused (403) → pairing-required, never connected', async () => {
    useProxyStore.setState({ token: 'mem', state: 'connected', authenticated: true });
    await useProxyStore.getState().refresh(
      fetchRouter({
        '/health': HEALTH_OK,
        '/api/session/verify': { status: 403, body: { error: 'refused' } },
      }),
    );
    const { state, token, authenticated } = useProxyStore.getState();
    expect(state).toBe('pairing-required');
    expect(token).toBeNull();
    expect(authenticated).toBe(false);
  });

  it('/health OK but verifyToken hits a network error → uncertain error, never connected', async () => {
    useProxyStore.setState({ token: 'mem', state: 'connected', authenticated: true });
    await useProxyStore.getState().refresh(fetchRouter({ '/health': HEALTH_OK }));
    const { state, authenticated } = useProxyStore.getState();
    expect(state).toBe('error');
    expect(authenticated).toBe(false);
  });

  it('getProxyRuntimeCredentials only returns a token when authenticated', () => {
    useProxyStore.setState({ token: 'tok', state: 'pairing-required', authenticated: false });
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
    useProxyStore.setState({ state: 'connected', authenticated: false });
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
    useProxyStore.setState({ token: 'tok', state: 'connected', authenticated: true });
    expect(getProxyRuntimeCredentials().proxyToken).toBe('tok');
  });

  it('late refresh verification cannot restore a revoked session', async () => {
    let releaseVerification: ((response: Response) => void) | undefined;
    let verificationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/api/session/verify')) {
        verificationStarted?.();
        return new Promise<Response>((resolve) => {
          releaseVerification = resolve;
        });
      }
      if (url.includes('/api/session/revoke')) {
        return { ok: true, status: 200, json: async () => ({ revoked: true }) } as Response;
      }
      return { ok: true, status: 200, json: async () => HEALTH_OK.body } as Response;
    };
    useProxyStore.setState({ token: 'tok', state: 'connected', authenticated: true });
    const refresh = useProxyStore.getState().refresh(fetchImpl);
    await started;
    await useProxyStore.getState().revoke(fetchImpl);
    releaseVerification?.({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, expiresAt: futureIso() }),
    } as Response);
    await refresh;
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(getProxyRuntimeCredentials().proxyToken).toBeNull();
  });

  it('late pairing request cannot restart polling after disconnect', async () => {
    let releaseRequest: ((response: Response) => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/api/pair/request')) {
        requestStarted?.();
        return new Promise<Response>((resolve) => {
          releaseRequest = resolve;
        });
      }
      return { ok: true, status: 200, json: async () => HEALTH_OK.body } as Response;
    };
    const pairing = useProxyStore.getState().startPairing(fetchImpl);
    await started;
    await useProxyStore.getState().revoke(fetchImpl);
    releaseRequest?.({
      ok: true,
      status: 201,
      json: async () => ({ pairingId: 'late', userCode: '123456', expiresAt: futureIso() }),
    } as Response);
    await pairing;
    expect(useProxyStore.getState().state).toBe('pairing-required');
    expect(useProxyStore.getState().pairingId).toBeNull();
    expect(useProxyStore.getState().userCode).toBeNull();
  });

  it('race: a late approval from a cancelled poll is ignored', async () => {
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
      await vi.advanceTimersByTimeAsync(PAIRING_POLL_INTERVAL_MS);
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

  it('revoke cancels the poll: no late approval reconnects', async () => {
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
