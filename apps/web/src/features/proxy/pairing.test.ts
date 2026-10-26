import { describe, expect, it } from 'vitest';
import {
  ProxyPairingError,
  exchangeToken,
  getPairingStatus,
  requestPairing,
  revokeSession,
  verifyToken,
} from './pairing';
import type { FetchLike } from '../../config/load-config';

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

describe('pairing', () => {
  it('requestPairing → pairingId + userCode', async () => {
    const result = await requestPairing(
      'http://127.0.0.1:37892',
      fetchJson(201, { pairingId: 'p1', userCode: '123456', expiresAt: 'x' }),
    );
    expect(result).toMatchObject({ pairingId: 'p1', userCode: '123456' });
  });

  it('requestPairing 403 → ORIGIN_FORBIDDEN', async () => {
    const error = await requestPairing(
      'http://127.0.0.1:37892',
      fetchJson(403, {
        error: 'origin not allowed',
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('ORIGIN_FORBIDDEN');
  });

  it('getPairingStatus pending → pending', async () => {
    const status = await getPairingStatus(
      'http://127.0.0.1:37892',
      'p1',
      fetchJson(200, { status: 'pending', expiresAt: 'x' }),
    );
    expect(status.status).toBe('pending');
  });

  it('getPairingStatus 404 → PAIRING_NOT_FOUND', async () => {
    const error = await getPairingStatus(
      'http://127.0.0.1:37892',
      'gone',
      fetchJson(404, { error: 'not found' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('PAIRING_NOT_FOUND');
  });

  it('exchangeToken → token', async () => {
    const result = await exchangeToken(
      'http://127.0.0.1:37892',
      'p1',
      fetchJson(200, { token: 'tok', expiresAt: 'x' }),
    );
    expect(result.token).toBe('tok');
  });

  it('exchangeToken 403 → PAIRING_NOT_APPROVED (invalid/expired token)', async () => {
    const error = await exchangeToken(
      'http://127.0.0.1:37892',
      'p1',
      fetchJson(403, { error: 'exchange impossible' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('PAIRING_NOT_APPROVED');
  });

  it('revokeSession → resolves without error', async () => {
    await expect(
      revokeSession('http://127.0.0.1:37892', 'tok', fetchJson(200, { revoked: true })),
    ).resolves.toBeUndefined();
  });

  it('revokeSession 404 → REVOKE_FAILED', async () => {
    const error = await revokeSession(
      'http://127.0.0.1:37892',
      'tok',
      fetchJson(404, { error: 'not found' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('REVOKE_FAILED');
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
    const result = await verifyToken('http://127.0.0.1:37892', 'tok', fetchImpl);
    expect(result).toEqual({ ok: true, expiresAt: '2030-01-01T00:00:00Z' });
    expect(seenUrl).toBe('http://127.0.0.1:37892/api/session/verify?token=tok');
  });

  it('verifyToken 200 without expiresAt → ok without expiresAt', async () => {
    const result = await verifyToken('http://127.0.0.1:37892', 'tok', fetchJson(200, { ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it('verifyToken 401 → ok:false', async () => {
    const result = await verifyToken(
      'http://127.0.0.1:37892',
      'tok',
      fetchJson(401, { error: 'invalid token' }),
    );
    expect(result).toEqual({ ok: false });
  });

  it('verifyToken 403 → ok:false', async () => {
    const result = await verifyToken(
      'http://127.0.0.1:37892',
      'tok',
      fetchJson(403, { error: 'origin refused' }),
    );
    expect(result).toEqual({ ok: false });
  });

  it('verifyToken network error → ProxyPairingError PROXY_UNREACHABLE', async () => {
    const error = await verifyToken('http://127.0.0.1:37892', 'tok', fetchNetworkError()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('PROXY_UNREACHABLE');
  });

  it('verifyToken unexpected status (500) → ProxyPairingError, not ok:false', async () => {
    const error = await verifyToken(
      'http://127.0.0.1:37892',
      'tok',
      fetchJson(500, { error: 'boom' }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProxyPairingError);
    expect((error as ProxyPairingError).code).toBe('PROXY_UNREACHABLE');
  });
});
