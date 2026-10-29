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
import { OTHER_ORIGIN, RELAY_ORIGIN, RELAY_WSS, TEST_PROXY_URL } from './testing/fixtures';

/** Only the scheme differs from the default proxy URL: both must be refused. */
const PROXY_WS_URL = TEST_PROXY_URL.replace('http://', 'ws://');
const PROXY_WSS_URL = TEST_PROXY_URL.replace('http://', 'wss://');
/** Loopback alternatives: a bare name, an IPv6 literal, the same over TLS. */
const PROXY_NAME_URL = 'http://localhost';
const PROXY_IPV6_URL = 'https://[::1]';
const PROXY_TLS_URL = `https://localhost:${DEFAULT_PROXY_PORT}`;
/** A wildcard listener is not a loopback address: it must be refused. */
const PROXY_WILDCARD_URL = `http://0.0.0.0:${DEFAULT_PROXY_PORT}`;
/** A remote HTTP origin: the local proxy is loopback-only. */
const REMOTE_HTTP_ORIGIN = `http://${RELAY_ORIGIN}`;

describe('local network proxy constants', () => {
  // The ports and the URL are part of the documented local pairing flow.
  it('exposes the loopback and the default port', () => {
    expect(DEFAULT_PROXY_HOST).toBe('127.0.0.1');
    expect(DEFAULT_PROXY_PORT).toBe(37892);
    expect(DEFAULT_PROXY_URL).toBe('http://127.0.0.1:37892');
  });
});

describe('validateProxyUrl', () => {
  it('accepts loopback http/https URLs', () => {
    expect(validateProxyUrl(TEST_PROXY_URL).ok).toBe(true);
    expect(validateProxyUrl(PROXY_NAME_URL).ok).toBe(true);
    expect(validateProxyUrl(PROXY_IPV6_URL).ok).toBe(true);
  });

  it('normalizes the returned URL', () => {
    const result = validateProxyUrl(TEST_PROXY_URL);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${TEST_PROXY_URL}/`);
  });

  it('rejects 0.0.0.0 and remote domains', () => {
    expect(validateProxyUrl(PROXY_WILDCARD_URL).ok).toBe(false);
    expect(validateProxyUrl(REMOTE_HTTP_ORIGIN).ok).toBe(false);
    expect(validateProxyUrl(OTHER_ORIGIN).ok).toBe(false);
  });

  it('rejects userinfo and fragment', () => {
    expect(validateProxyUrl(TEST_PROXY_URL.replace('//', '//user@')).ok).toBe(false);
    expect(validateProxyUrl(TEST_PROXY_URL.replace('//', '//user:pass@')).ok).toBe(false);
    expect(validateProxyUrl(`${TEST_PROXY_URL}#frag`).ok).toBe(false);
  });

  it('rejects non-http(s) schemes and non-string input', () => {
    expect(validateProxyUrl(PROXY_WS_URL).ok).toBe(false);
    expect(validateProxyUrl(PROXY_WSS_URL).ok).toBe(false);
    expect(validateProxyUrl('').ok).toBe(false);
    expect(validateProxyUrl(undefined).ok).toBe(false);
    expect(validateProxyUrl(42).ok).toBe(false);
  });
});

describe('buildProxyWispUrl', () => {
  it('builds the local WISP URL without a token', () => {
    expect(buildProxyWispUrl(TEST_PROXY_URL)).toBe('ws://127.0.0.1:37892/wisp/');
  });

  it('adds the encoded token as a query parameter', () => {
    expect(buildProxyWispUrl(TEST_PROXY_URL, 'x')).toBe('ws://127.0.0.1:37892/wisp/?token=x');
  });

  it('converts https to wss', () => {
    expect(buildProxyWispUrl(PROXY_TLS_URL, 'abc')).toBe(
      `wss://localhost:${DEFAULT_PROXY_PORT}/wisp/?token=abc`,
    );
  });

  it('throws on an invalid local network proxy URL', () => {
    expect(() => buildProxyWispUrl(RELAY_WSS.replace('wss://', 'https://'))).toThrow();
  });
});

describe('selectEffectiveNetworkProfile', () => {
  it('switches to local-proxy when the local network proxy is connected (token present)', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { connected: true, proxyUrl: TEST_PROXY_URL, proxyToken: 'tok' },
    );
    expect(result).toEqual({
      mode: 'local-proxy',
      proxyUrl: TEST_PROXY_URL,
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
    const relayUrl = `${RELAY_WSS}/wisp/`;
    const result = selectEffectiveNetworkProfile(
      { mode: 'user-relay', relayUrl },
      { connected: true, proxyToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'user-relay', relayUrl });
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
