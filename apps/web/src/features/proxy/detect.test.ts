import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProxy } from './detect';
import type { FetchLike } from '../../config/load-config';
import { TEST_PROXY_URL } from '../../test/fixtures';

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

describe('checkProxy', () => {
  it('local network proxy stopped (network error) → not-running', async () => {
    const health = await checkProxy(TEST_PROXY_URL, fetchFail(new TypeError('Failed to fetch')));
    expect(health.state).toBe('not-running');
  });

  it('timeout (AbortError) → not-running', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const health = await checkProxy(TEST_PROXY_URL, fetchFail(abort));
    expect(health.state).toBe('not-running');
  });

  it('non-JSON response / unexpected shape → incompatible', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }) as unknown as Response) as FetchLike;
    expect((await checkProxy(TEST_PROXY_URL, fetchImpl)).state).toBe('incompatible');
    expect((await checkProxy(TEST_PROXY_URL, fetchOk({ status: 'ko' }))).state).toBe(
      'incompatible',
    );
  });

  it('different wispVersion → incompatible', async () => {
    const health = await checkProxy(
      TEST_PROXY_URL,
      fetchOk({ status: 'ok', version: '9.9.9', wispVersion: 2 }),
    );
    expect(health.state).toBe('incompatible');
    expect(health.wispVersion).toBe(2);
  });

  it('healthy /health → connected (reached)', async () => {
    const health = await checkProxy(
      TEST_PROXY_URL,
      fetchOk({ status: 'ok', version: '0.1.0', wispVersion: 1 }),
    );
    expect(health).toMatchObject({ state: 'connected', wispVersion: 1 });
  });

  it('TypeError in a secure Chromium context → uncertain error (never asserted)', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36',
      userAgentData: {},
    });
    const health = await checkProxy(TEST_PROXY_URL, fetchFail(new TypeError('Failed to fetch')));
    expect(health.state).toBe('error');
    expect(health.uncertain).toBe(true);
    expect(health.error).toMatch(/local network proxy/i);
  });
});
