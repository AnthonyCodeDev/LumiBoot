import { describe, expect, it } from 'vitest';
import { NetworkError } from './errors';
import {
  defaultNetworkProfile,
  networkProfileSchema,
  normalizeNetworkProfile,
  validateNetworkProfile,
} from './profile';
import { RELAY_WSS, TEST_PROXY_URL } from './testing/fixtures';

describe('defaultNetworkProfile', () => {
  it('is offline and without a public relay', () => {
    expect(defaultNetworkProfile.mode).toBe('offline');
    expect(defaultNetworkProfile.relayUrl).toBeUndefined();
  });
});

describe('networkProfileSchema', () => {
  it('rejects unknown keys', () => {
    expect(networkProfileSchema.safeParse({ mode: 'offline', extra: 1 }).success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    expect(networkProfileSchema.safeParse({ mode: 'wifi' }).success).toBe(false);
  });
});

describe('normalizeNetworkProfile', () => {
  it('keeps relayUrl only in user-relay mode', () => {
    expect(normalizeNetworkProfile({ mode: 'user-relay', relayUrl: RELAY_WSS })).toEqual({
      mode: 'user-relay',
      relayUrl: RELAY_WSS,
    });

    expect(normalizeNetworkProfile({ mode: 'offline', relayUrl: RELAY_WSS })).toEqual({
      mode: 'offline',
    });

    expect(normalizeNetworkProfile({ mode: 'browser-fetch', relayUrl: RELAY_WSS })).toEqual({
      mode: 'browser-fetch',
    });
  });

  it('keeps proxyUrl/proxyToken only in local-proxy mode', () => {
    expect(
      normalizeNetworkProfile({
        mode: 'local-proxy',
        proxyUrl: TEST_PROXY_URL,
        proxyToken: 'abc',
      }),
    ).toEqual({
      mode: 'local-proxy',
      proxyUrl: TEST_PROXY_URL,
      proxyToken: 'abc',
    });

    expect(normalizeNetworkProfile({ mode: 'local-proxy', relayUrl: RELAY_WSS })).toEqual({
      mode: 'local-proxy',
    });

    expect(
      normalizeNetworkProfile({
        mode: 'offline',
        proxyUrl: TEST_PROXY_URL,
        proxyToken: 'abc',
      }),
    ).toEqual({ mode: 'offline' });

    expect(
      normalizeNetworkProfile({
        mode: 'user-relay',
        relayUrl: RELAY_WSS,
        proxyUrl: TEST_PROXY_URL,
      }),
    ).toEqual({ mode: 'user-relay', relayUrl: RELAY_WSS });
  });

  it('throws a NetworkError on invalid input', () => {
    expect(() => normalizeNetworkProfile({ mode: 'nope' })).toThrow(NetworkError);
    expect(() => normalizeNetworkProfile(null)).toThrow(NetworkError);
  });
});

describe('validateNetworkProfile', () => {
  it('accepts and cleans a valid profile', () => {
    const result = validateNetworkProfile({ mode: 'user-relay', relayUrl: RELAY_WSS });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual({ mode: 'user-relay', relayUrl: RELAY_WSS });
  });

  it('returns the errors without throwing', () => {
    const result = validateNetworkProfile({ mode: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.profile).toBeUndefined();
  });
});
