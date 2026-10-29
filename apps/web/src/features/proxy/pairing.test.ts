import { describe, expect, it, vi } from 'vitest';
import {
  PAIRING_REQUEST_TIMEOUT_MS,
  ProxyPairingError,
  exchangeToken,
  fetchWithTimeout,
  getPairingStatus,
  requestPairing,
  revokeSession,
  verifyToken,
} from './pairing';
import type { FetchLike } from '../../config/load-config';
import { TEST_PROXY_URL } from '../../test/fixtures';

function fetchJson(status: number, body: unknown): FetchLike {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as FetchLike;
}

function fetchNetworkError(): FetchLike {
  return (async () => {
    throw new TypeError('Failed to fetch');
  }) as FetchLike;
}

/** A server that accepts the request and never answers. */
function fetchNever(): FetchLike {
  return (() => new Promise<Response>(() => {})) as FetchLike;
}

describe('pairing', () => {
  it('requestPairing → pairingId + userCode', async () => {
    const result = await requestPairing(
      TEST_PROXY_URL,
      fetchJson(201, { pairingId: 'p1', userCode: '123456', expiresAt: 'x' }),
    );
    expect(result).toMatchObject({ pairingId: 'p1', userCode: '123456' });
  });

  it('requestPairing sends no origin field in the body (header only)', async () => {
    let seenBody = '';
    const fetchImpl: FetchLike = (async (_input: string, init?: RequestInit) => {
      seenBody = String(init?.body);
      return {
        ok: true,
        status: 201,
        json: async () => ({ pairingId: 'p1', userCode: '123456', expiresAt: 'x' }),
      } as unknown as Response;
    }) as FetchLike;
    await requestPairing(TEST_PROXY_URL, fetchImpl);
    expect(JSON.parse(seenBody)).toEqual({});
    expect(JSON.parse(seenBody)).not.toHaveProperty('origin');
  });

  it('requestPairing 403 → ORIGIN_FORBIDDEN', async () => {
    const error = await requestPairing(
      TEST_PROXY_URL,
      fetchJson(403, {
        error: 'origin not allowed',
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('ORIGIN_FORBIDDEN');
  });

  it('rejects a malformed pairing response with a typed error', async () => {
    await expect(requestPairing(TEST_PROXY_URL, fetchJson(201, null))).rejects.toMatchObject({
      code: 'PROXY_UNREACHABLE',
    });
  });

  it('getPairingStatus pending → pending', async () => {
    const status = await getPairingStatus(
      TEST_PROXY_URL,
      'p1',
      fetchJson(200, { status: 'pending', expiresAt: 'x' }),
    );
    expect(status.status).toBe('pending');
  });

  it('getPairingStatus 404 → PAIRING_NOT_FOUND', async () => {
    const error = await getPairingStatus(
      TEST_PROXY_URL,
      'gone',
      fetchJson(404, { error: 'not found' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('PAIRING_NOT_FOUND');
  });

  it('rejects a malformed pairing status with a typed error', async () => {
    await expect(
      getPairingStatus(TEST_PROXY_URL, 'p1', fetchJson(200, null)),
    ).rejects.toMatchObject({ code: 'PROXY_UNREACHABLE' });
  });

  it('exchangeToken → token', async () => {
    const result = await exchangeToken(
      TEST_PROXY_URL,
      'p1',
      fetchJson(200, { token: 'tok', expiresAt: 'x' }),
    );
    expect(result.token).toBe('tok');
  });

  it('exchangeToken 403 → PAIRING_NOT_APPROVED (invalid/expired token)', async () => {
    const error = await exchangeToken(
      TEST_PROXY_URL,
      'p1',
      fetchJson(403, { error: 'exchange impossible' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('PAIRING_NOT_APPROVED');
  });

  it('rejects a malformed token exchange with a typed error', async () => {
    await expect(exchangeToken(TEST_PROXY_URL, 'p1', fetchJson(200, null))).rejects.toMatchObject({
      code: 'PROXY_UNREACHABLE',
    });
  });

  it('revokeSession → resolves without error', async () => {
    await expect(
      revokeSession(TEST_PROXY_URL, 'tok', fetchJson(200, { revoked: true })),
    ).resolves.toBeUndefined();
  });

  it('revokeSession 404 → REVOKE_FAILED', async () => {
    const error = await revokeSession(
      TEST_PROXY_URL,
      'tok',
      fetchJson(404, { error: 'not found' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('REVOKE_FAILED');
  });

  it('rejects a malformed revocation response with a typed error', async () => {
    await expect(revokeSession(TEST_PROXY_URL, 'tok', fetchJson(200, null))).rejects.toMatchObject({
      code: 'REVOKE_FAILED',
    });
  });

  it('verifyToken 200 {ok:true} → ok + expiresAt, token in query', async () => {
    let seenUrl = '';
    const fetchImpl: FetchLike = (async (input: string) => {
      seenUrl = input;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, expiresAt: '2030-01-01T00:00:00Z' }),
      } as unknown as Response;
    }) as FetchLike;
    const result = await verifyToken(TEST_PROXY_URL, 'tok', fetchImpl);
    expect(result).toEqual({ ok: true, expiresAt: '2030-01-01T00:00:00Z' });
    expect(seenUrl).toBe(`${TEST_PROXY_URL}/api/session/verify?token=tok`);
  });

  it('verifyToken 200 without expiresAt → ok without expiresAt', async () => {
    const result = await verifyToken(TEST_PROXY_URL, 'tok', fetchJson(200, { ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('rejects a malformed verification response with a typed error', async () => {
    await expect(verifyToken(TEST_PROXY_URL, 'tok', fetchJson(200, null))).rejects.toMatchObject({
      code: 'PROXY_UNREACHABLE',
    });
  });

  it('verifyToken 401 → ok:false', async () => {
    const result = await verifyToken(
      TEST_PROXY_URL,
      'tok',
      fetchJson(401, { error: 'invalid token' }),
    );
    expect(result).toEqual({ ok: false });
  });

  it('verifyToken 403 → ok:false', async () => {
    const result = await verifyToken(
      TEST_PROXY_URL,
      'tok',
      fetchJson(403, { error: 'origin refused' }),
    );
    expect(result).toEqual({ ok: false });
  });

  it('verifyToken network error → ProxyPairingError PROXY_UNREACHABLE', async () => {
    const error = await verifyToken(TEST_PROXY_URL, 'tok', fetchNetworkError()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('PROXY_UNREACHABLE');
  });

  it('verifyToken unexpected status (500) → ProxyPairingError, not ok:false', async () => {
    const error = await verifyToken(TEST_PROXY_URL, 'tok', fetchJson(500, { error: 'boom' })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('PROXY_UNREACHABLE');
  });

  describe('request deadline', () => {
    it('fetchWithTimeout → PROXY_TIMEOUT when the answer never arrives', async () => {
      const error = await fetchWithTimeout(fetchNever(), `${TEST_PROXY_URL}/x`, {}, 10).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProxyPairingError);
      expect((error as ProxyPairingError).code).toBe('PROXY_TIMEOUT');
      expect((error as ProxyPairingError).message).toBe(
        'The local network proxy did not answer in time.',
      );
    });

    it('fetchWithTimeout resolves a fast answer', async () => {
      const response = await fetchWithTimeout(
        fetchJson(200, { ok: true }),
        `${TEST_PROXY_URL}/x`,
        {},
        10_000,
      );
      expect(response.status).toBe(200);
    });

    it('fetchWithTimeout forwards an already aborted external signal immediately', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await fetchWithTimeout(
        fetchNever(),
        `${TEST_PROXY_URL}/x`,
        { signal: controller.signal },
        10_000,
      ).catch((e: unknown) => e);
      expect((error as Error).name).toBe('AbortError');
    });

    it('fetchWithTimeout forwards a later external abort', async () => {
      const controller = new AbortController();
      const request = fetchWithTimeout(fetchNever(), `${TEST_PROXY_URL}/x`, {
        signal: controller.signal,
      });
      controller.abort();
      const error = await request.catch((e: unknown) => e);
      expect((error as Error).name).toBe('AbortError');
    });

    it('getPairingStatus applies PAIRING_REQUEST_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        const request = getPairingStatus(TEST_PROXY_URL, 'p1', fetchNever()).catch(
          (e: unknown) => e,
        );
        await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS);
        const error = await request;
        expect(error).toBeInstanceOf(ProxyPairingError);
        expect((error as ProxyPairingError).code).toBe('PROXY_TIMEOUT');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
