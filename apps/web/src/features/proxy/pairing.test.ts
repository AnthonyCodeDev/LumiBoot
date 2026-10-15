import { describe, expect, it } from 'vitest';
import {
  ProxyPairingError,
  exchangeToken,
  getPairingStatus,
  requestPairing,
  revokeSession,
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
        error: 'origine non autorisée',
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
      fetchJson(404, { error: 'introuvable' }),
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

  it('exchangeToken 403 → PAIRING_NOT_APPROVED (token invalide/expiré)', async () => {
    const error = await exchangeToken(
      'http://127.0.0.1:37892',
      'p1',
      fetchJson(403, { error: 'échange impossible' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('PAIRING_NOT_APPROVED');
  });

  it('revokeSession → résout sans erreur', async () => {
    await expect(
      revokeSession('http://127.0.0.1:37892', 'tok', fetchJson(200, { revoked: true })),
    ).resolves.toBeUndefined();
  });

  it('revokeSession 404 → REVOKE_FAILED', async () => {
    const error = await revokeSession(
      'http://127.0.0.1:37892',
      'tok',
      fetchJson(404, { error: 'introuvable' }),
    ).catch((e: unknown) => e);
    expect((error as ProxyPairingError).code).toBe('REVOKE_FAILED');
  });
});
