import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCompanion } from './detect';
import type { FetchLike } from '../../config/load-config';

function fetchOk(body: unknown): FetchLike {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
    }) as unknown as Response) as FetchLike;
}

function fetchFail(error: unknown): FetchLike {
  return (async () => {
    throw error;
  }) as FetchLike;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkCompanion', () => {
  it('compagnon arrêté (erreur réseau) → not-running', async () => {
    const health = await checkCompanion(
      'http://127.0.0.1:37892',
      fetchFail(new TypeError('Failed to fetch')),
    );
    expect(health.state).toBe('not-running');
  });

  it('timeout (AbortError) → not-running', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const health = await checkCompanion('http://127.0.0.1:37892', fetchFail(abort));
    expect(health.state).toBe('not-running');
  });

  it('réponse non-JSON / forme inattendue → incompatible', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }) as unknown as Response) as FetchLike;
    expect((await checkCompanion('http://127.0.0.1:37892', fetchImpl)).state).toBe('incompatible');
    expect((await checkCompanion('http://127.0.0.1:37892', fetchOk({ status: 'ko' }))).state).toBe(
      'incompatible',
    );
  });

  it('wispVersion différente → incompatible', async () => {
    const health = await checkCompanion(
      'http://127.0.0.1:37892',
      fetchOk({ status: 'ok', version: '9.9.9', wispVersion: 2 }),
    );
    expect(health.state).toBe('incompatible');
    expect(health.wispVersion).toBe(2);
  });

  it('succès /health → connected (joint)', async () => {
    const health = await checkCompanion(
      'http://127.0.0.1:37892',
      fetchOk({ status: 'ok', version: '0.1.0', wispVersion: 1 }),
    );
    expect(health).toMatchObject({ state: 'connected', wispVersion: 1 });
  });

  it('TypeError en contexte sécurisé Chromium → permission-required (heuristique)', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
      userAgentData: {},
    });
    const health = await checkCompanion(
      'http://127.0.0.1:37892',
      fetchFail(new TypeError('Failed to fetch')),
    );
    expect(health.state).toBe('permission-required');
  });
});
