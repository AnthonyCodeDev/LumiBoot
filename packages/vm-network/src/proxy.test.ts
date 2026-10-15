import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_PROXY_PORT,
  DEFAULT_PROXY_URL,
  DEFAULT_NETWORK_FALLBACK_MODE,
  buildProxyWispUrl,
  selectEffectiveNetworkProfile,
  validateProxyUrl,
} from './proxy';

describe('constantes du proxy réseau local', () => {
  it('expose le loopback et le port par défaut', () => {
    expect(DEFAULT_PROXY_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PROXY_PORT).toBe(37892);
    expect(DEFAULT_PROXY_URL).toBe('http://127.0.0.1:37892');
  });
});

describe('validateProxyUrl', () => {
  it('accepte les URL loopback http/https', () => {
    expect(validateProxyUrl('http://127.0.0.1:37892').ok).toBe(true);
    expect(validateProxyUrl('http://localhost').ok).toBe(true);
    expect(validateProxyUrl('https://[::1]').ok).toBe(true);
  });

  it('normalise l’URL renvoyée', () => {
    const result = validateProxyUrl('http://127.0.0.1:37892');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:37892/');
  });

  it('rejette 0.0.0.0 et les domaines distants', () => {
    expect(validateProxyUrl('http://0.0.0.0:37892').ok).toBe(false);
    expect(validateProxyUrl('http://relay.example').ok).toBe(false);
    expect(validateProxyUrl('https://example.com').ok).toBe(false);
  });

  it('rejette userinfo et fragment', () => {
    expect(validateProxyUrl('http://user@127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('http://user:pass@127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('http://127.0.0.1:37892#frag').ok).toBe(false);
  });

  it('rejette les schémas non http(s) et les entrées non textuelles', () => {
    expect(validateProxyUrl('ws://127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('wss://127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('').ok).toBe(false);
    expect(validateProxyUrl(undefined).ok).toBe(false);
    expect(validateProxyUrl(42).ok).toBe(false);
  });
});

describe('buildProxyWispUrl', () => {
  it('construit l’URL WISP locale sans jeton', () => {
    expect(buildProxyWispUrl('http://127.0.0.1:37892')).toBe('ws://127.0.0.1:37892/wisp/');
  });

  it('ajoute le jeton encodé en requête', () => {
    expect(buildProxyWispUrl('http://127.0.0.1:37892', 'x')).toBe(
      'ws://127.0.0.1:37892/wisp/?token=x',
    );
  });

  it('convertit https en wss', () => {
    expect(buildProxyWispUrl('https://localhost:37892', 'abc')).toBe(
      'wss://localhost:37892/wisp/?token=abc',
    );
  });

  it('lève sur une URL proxy réseau local invalide', () => {
    expect(() => buildProxyWispUrl('https://relay.example')).toThrow();
  });
});

describe('selectEffectiveNetworkProfile', () => {
  it('passe en local-proxy quand le proxy réseau local est connecté (jeton présent)', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { connected: true, proxyUrl: 'http://127.0.0.1:37892', proxyToken: 'tok' },
    );
    expect(result).toEqual({
      mode: 'local-proxy',
      proxyUrl: 'http://127.0.0.1:37892',
      proxyToken: 'tok',
    });
  });

  it('replie local-proxy sur browser-fetch sans proxy réseau local connecté', () => {
    expect(selectEffectiveNetworkProfile({ mode: 'local-proxy' }, { connected: false })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
    expect(selectEffectiveNetworkProfile({ mode: 'local-proxy' }, { connected: true })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
  });

  it('respecte le mode offline même avec un proxy réseau local connecté', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'offline' },
      { connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'offline' });
  });

  it('respecte le mode user-relay même avec un proxy réseau local connecté', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' },
      { connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' });
  });

  it('conserve le mode de base si le proxy réseau local est désactivé', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { enabled: false, connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'browser-fetch' });
  });

  it('laisse browser-fetch inchangé sans proxy réseau local connecté', () => {
    const result = selectEffectiveNetworkProfile({ mode: 'browser-fetch' }, { connected: false });
    expect(result).toEqual({ mode: 'browser-fetch' });
  });
});
