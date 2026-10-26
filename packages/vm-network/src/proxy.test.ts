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

describe('local network proxy constants', () => {
  it('exposes the loopback and the default port', () => {
    expect(DEFAULT_PROXY_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PROXY_PORT).toBe(37892);
    expect(DEFAULT_PROXY_URL).toBe('http://127.0.0.1:37892');
  });
});

describe('validateProxyUrl', () => {
  it('accepts loopback http/https URLs', () => {
    expect(validateProxyUrl('http://127.0.0.1:37892').ok).toBe(true);
    expect(validateProxyUrl('http://localhost').ok).toBe(true);
    expect(validateProxyUrl('https://[::1]').ok).toBe(true);
  });

  it('normalizes the returned URL', () => {
    const result = validateProxyUrl('http://127.0.0.1:37892');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:37892/');
  });

  it('rejects 0.0.0.0 and remote domains', () => {
    expect(validateProxyUrl('http://0.0.0.0:37892').ok).toBe(false);
    expect(validateProxyUrl('http://relay.example').ok).toBe(false);
    expect(validateProxyUrl('https://example.com').ok).toBe(false);
  });

  it('rejects userinfo and fragment', () => {
    expect(validateProxyUrl('http://user@127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('http://user:pass@127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('http://127.0.0.1:37892#frag').ok).toBe(false);
  });

  it('rejects non-http(s) schemes and non-string input', () => {
    expect(validateProxyUrl('ws://127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('wss://127.0.0.1:37892').ok).toBe(false);
    expect(validateProxyUrl('').ok).toBe(false);
    expect(validateProxyUrl(undefined).ok).toBe(false);
    expect(validateProxyUrl(42).ok).toBe(false);
  });
});

describe('buildProxyWispUrl', () => {
  it('builds the local WISP URL without a token', () => {
    expect(buildProxyWispUrl('http://127.0.0.1:37892')).toBe('ws://127.0.0.1:37892/wisp/');
  });

  it('adds the encoded token as a query parameter', () => {
    expect(buildProxyWispUrl('http://127.0.0.1:37892', 'x')).toBe(
      'ws://127.0.0.1:37892/wisp/?token=x',
    );
  });

  it('converts https to wss', () => {
    expect(buildProxyWispUrl('https://localhost:37892', 'abc')).toBe(
      'wss://localhost:37892/wisp/?token=abc',
    );
  });

  it('throws on an invalid local network proxy URL', () => {
    expect(() => buildProxyWispUrl('https://relay.example')).toThrow();
  });
});

describe('selectEffectiveNetworkProfile', () => {
  it('switches to local-proxy when the local network proxy is connected (token present)', () => {
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

  it('falls back from local-proxy to browser-fetch without a connected local network proxy', () => {
    expect(selectEffectiveNetworkProfile({ mode: 'local-proxy' }, { connected: false })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
    expect(selectEffectiveNetworkProfile({ mode: 'local-proxy' }, { connected: true })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
  });

  it('respects the offline mode even with a connected local network proxy', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'offline' },
      { connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'offline' });
  });

  it('respects the user-relay mode even with a connected local network proxy', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' },
      { connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' });
  });

  it('keeps the base mode when the local network proxy is disabled', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { enabled: false, connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'browser-fetch' });
  });

  it('leaves browser-fetch unchanged without a connected local network proxy', () => {
    const result = selectEffectiveNetworkProfile({ mode: 'browser-fetch' }, { connected: false });
    expect(result).toEqual({ mode: 'browser-fetch' });
  });
});
