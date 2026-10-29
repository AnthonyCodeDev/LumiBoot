import { describe, expect, it } from 'vitest';
import { CONFIG_URL, ConfigLoadError, loadConfig, type FetchLike } from './load-config';
import { resolveNetworkProfile, setRuntimeConfig } from './runtime';
import type { LumibootConfig } from './schema';
import { RELAY_WSS_PORT, TEST_PROXY_URL } from '../test/fixtures';

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
}

/** Minimal response exposing only what `loadConfig` consumes. */
function makeResponse(body: string, init: FakeResponseInit = {}): Response {
  const contentType = init.contentType === undefined ? 'application/json' : init.contentType;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: async () => body,
  } as unknown as Response;
}

function fetchReturning(response: Response): FetchLike {
  return async () => response;
}

function fetchReturningJson(body: unknown): FetchLike {
  return fetchReturning(makeResponse(JSON.stringify(body)));
}

async function loadAndCatch(fetchImpl: FetchLike): Promise<ConfigLoadError> {
  try {
    await loadConfig(fetchImpl);
  } catch (error) {
    if (error instanceof ConfigLoadError) return error;
    throw error;
  }
  throw new Error('Expected ConfigLoadError but no error was thrown.');
}

const VALID_CONFIG = {
  version: 1,
  network: {
    defaultProfile: { mode: 'browser-fetch' },
    systems: { 'debian-12-i386': { mode: 'browser-fetch' } },
  },
};

describe('loadConfig', () => {
  it('loads and normalizes a valid configuration', async () => {
    const config = await loadConfig(fetchReturningJson(VALID_CONFIG));
    expect(config.version).toBe(1);
    expect(config.network.defaultProfile).toEqual({ mode: 'browser-fetch' });
    expect(config.network.systems?.['debian-12-i386']).toEqual({ mode: 'browser-fetch' });
    expect(config.proxy.enabled).toBe(true);
    expect(config.proxy.url).toContain(TEST_PROXY_URL);
  });

  it('applies the local network proxy defaults when the section is absent', async () => {
    const config = await loadConfig(fetchReturningJson(VALID_CONFIG));
    expect(config.proxy).toEqual({
      enabled: true,
      url: `${TEST_PROXY_URL}/`,
    });
  });

  it('rejects a non-loopback proxy.url', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { url: 'http://example.com:37892' },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_PROXY_URL');
  });

  it('rejects a malformed proxy.url', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { url: 'not-a-url' },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_PROXY_URL');
  });

  it('rejects any proxyToken persisted in the public file', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'local-proxy', proxyToken: 'secret' },
        },
      }),
    );
    expect(error.code).toBe('CONFIG_FORBIDDEN_TOKEN');
  });

  it('rejects a proxyToken nested in the proxy section', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { enabled: true, url: TEST_PROXY_URL, proxyToken: 'x' },
      }),
    );
    expect(error.code).toBe('CONFIG_FORBIDDEN_TOKEN');
  });

  it('targets the public file with caching disabled', async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return makeResponse(JSON.stringify(VALID_CONFIG));
    };
    await loadConfig(fetchImpl);
    expect(seenUrl).toBe(CONFIG_URL);
    expect(seenInit?.cache).toBe('no-store');
  });

  it('rejects an invalid JSON body', async () => {
    const error = await loadAndCatch(fetchReturning(makeResponse('{ not json')));
    expect(error.code).toBe('CONFIG_INVALID_JSON');
  });

  it('rejects an incompatible config version', async () => {
    const error = await loadAndCatch(fetchReturningJson({ ...VALID_CONFIG, version: 2 }));
    expect(error.code).toBe('CONFIG_VERSION_UNSUPPORTED');
  });

  it('rejects an unknown network mode', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        version: 1,
        network: { defaultProfile: { mode: 'quantum' } },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_MODE');
  });

  it('rejects an invalid WISP relay address (ws://)', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'user-relay', relayUrl: RELAY_WSS_PORT.replace('wss:', 'ws:') },
        },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_RELAY');
  });

  it('accepts a valid wss:// relay address', async () => {
    const config = await loadConfig(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'user-relay', relayUrl: RELAY_WSS_PORT },
        },
      }),
    );
    expect(config.network.defaultProfile.mode).toBe('user-relay');
    expect(config.network.defaultProfile.relayUrl).toContain(RELAY_WSS_PORT);
  });

  it('rejects a missing configuration (404)', async () => {
    const error = await loadAndCatch(
      fetchReturning(
        makeResponse('Not Found', { ok: false, status: 404, statusText: 'Not Found' }),
      ),
    );
    expect(error.code).toBe('CONFIG_NOT_FOUND');
  });

  it('rejects the SPA fallback (HTML page served instead of JSON)', async () => {
    const error = await loadAndCatch(
      fetchReturning(
        makeResponse('<!doctype html><html><body>app</body></html>', {
          contentType: 'text/html; charset=utf-8',
        }),
      ),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });

  it('rejects a body starting with "<" even without an HTML header', async () => {
    const error = await loadAndCatch(
      fetchReturning(makeResponse('  <html></html>', { contentType: 'application/json' })),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });
});

describe('resolveNetworkProfile', () => {
  it('prioritizes the system-specific profile over the default profile', async () => {
    const config = await loadConfig(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'offline' },
          systems: { 'debian-12-i386': { mode: 'browser-fetch' } },
        },
      }),
    );
    setRuntimeConfig(config);

    expect(resolveNetworkProfile('debian-12-i386')).toEqual({ mode: 'browser-fetch' });
    expect(resolveNetworkProfile('unknown')).toEqual({ mode: 'offline' });
  });

  it('applies the default profile when no system matches', () => {
    const config: LumibootConfig = {
      version: 1,
      network: { defaultProfile: { mode: 'user-relay', relayUrl: RELAY_WSS_PORT } },
      proxy: { enabled: true, url: `${TEST_PROXY_URL}/` },
    };
    setRuntimeConfig(config);
    expect(resolveNetworkProfile('other')).toEqual({
      mode: 'user-relay',
      relayUrl: RELAY_WSS_PORT,
    });
  });
});
