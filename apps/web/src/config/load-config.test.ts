import { describe, expect, it } from 'vitest';
import { CONFIG_URL, ConfigLoadError, loadConfig, type FetchLike } from './load-config';
import { resolveNetworkProfile, setRuntimeConfig } from './runtime';
import type { LumibootConfig } from './schema';

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
}

/** Réponse minimale n'exposant que ce que `loadConfig` consomme. */
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
  throw new Error('ConfigLoadError attendue mais aucune erreur levée.');
}

const VALID_CONFIG = {
  version: 1,
  network: {
    defaultProfile: { mode: 'browser-fetch' },
    systems: { 'debian-12-i386': { mode: 'browser-fetch' } },
  },
};

describe('loadConfig', () => {
  it('charge et normalise une configuration valide', async () => {
    const config = await loadConfig(fetchReturningJson(VALID_CONFIG));
    expect(config.version).toBe(1);
    expect(config.network.defaultProfile).toEqual({ mode: 'browser-fetch' });
    expect(config.network.systems?.['debian-12-i386']).toEqual({ mode: 'browser-fetch' });
    expect(config.proxy.enabled).toBe(true);
    expect(config.proxy.url).toContain('127.0.0.1:37892');
  });

  it('applique les défauts proxy réseau local en l’absence de section dédiée', async () => {
    const config = await loadConfig(fetchReturningJson(VALID_CONFIG));
    expect(config.proxy).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:37892/',
    });
  });

  it('rejette une proxy.url non loopback', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { url: 'http://example.com:37892' },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_PROXY_URL');
  });

  it('rejette une proxy.url mal formée', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { url: 'pas-une-url' },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_PROXY_URL');
  });

  it('rejette tout proxyToken persisté dans le fichier public', async () => {
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

  it('rejette un proxyToken niché dans la section proxy', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        ...VALID_CONFIG,
        proxy: { enabled: true, url: 'http://127.0.0.1:37892', proxyToken: 'x' },
      }),
    );
    expect(error.code).toBe('CONFIG_FORBIDDEN_TOKEN');
  });

  it('cible bien le fichier public avec cache désactivé', async () => {
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

  it('rejette un corps JSON invalide', async () => {
    const error = await loadAndCatch(fetchReturning(makeResponse('{ pas du json')));
    expect(error.code).toBe('CONFIG_INVALID_JSON');
  });

  it('rejette une version de configuration incompatible', async () => {
    const error = await loadAndCatch(fetchReturningJson({ ...VALID_CONFIG, version: 2 }));
    expect(error.code).toBe('CONFIG_VERSION_UNSUPPORTED');
  });

  it('rejette un mode réseau inconnu', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        version: 1,
        network: { defaultProfile: { mode: 'quantum' } },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_MODE');
  });

  it('rejette une adresse de relais WISP invalide (ws://)', async () => {
    const error = await loadAndCatch(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'user-relay', relayUrl: 'ws://relay.example:4000' },
        },
      }),
    );
    expect(error.code).toBe('CONFIG_INVALID_RELAY');
  });

  it('accepte une adresse de relais wss:// valide', async () => {
    const config = await loadConfig(
      fetchReturningJson({
        version: 1,
        network: {
          defaultProfile: { mode: 'user-relay', relayUrl: 'wss://relay.example:4000' },
        },
      }),
    );
    expect(config.network.defaultProfile.mode).toBe('user-relay');
    expect(config.network.defaultProfile.relayUrl).toContain('wss://relay.example:4000');
  });

  it("rejette l'absence de configuration (404)", async () => {
    const error = await loadAndCatch(
      fetchReturning(
        makeResponse('Not Found', { ok: false, status: 404, statusText: 'Not Found' }),
      ),
    );
    expect(error.code).toBe('CONFIG_NOT_FOUND');
  });

  it('rejette le repli SPA (page HTML servie à la place du JSON)', async () => {
    const error = await loadAndCatch(
      fetchReturning(
        makeResponse('<!doctype html><html><body>app</body></html>', {
          contentType: 'text/html; charset=utf-8',
        }),
      ),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });

  it('rejette un corps commençant par « < » même sans en-tête HTML', async () => {
    const error = await loadAndCatch(
      fetchReturning(makeResponse('  <html></html>', { contentType: 'application/json' })),
    );
    expect(error.code).toBe('CONFIG_INVALID');
  });
});

describe('resolveNetworkProfile', () => {
  it('priorise le profil spécifique au système sur le profil par défaut', async () => {
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
    expect(resolveNetworkProfile('inconnu')).toEqual({ mode: 'offline' });
  });

  it('applique le profil par défaut quand aucun système ne correspond', () => {
    const config: LumibootConfig = {
      version: 1,
      network: { defaultProfile: { mode: 'user-relay', relayUrl: 'wss://relay.example:4000' } },
      proxy: { enabled: true, url: 'http://127.0.0.1:37892/' },
    };
    setRuntimeConfig(config);
    expect(resolveNetworkProfile('autre')).toEqual({
      mode: 'user-relay',
      relayUrl: 'wss://relay.example:4000',
    });
  });
});
