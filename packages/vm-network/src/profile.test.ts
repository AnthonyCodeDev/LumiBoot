import { describe, expect, it } from 'vitest';
import { NetworkError } from './errors';
import {
  defaultNetworkProfile,
  networkProfileSchema,
  normalizeNetworkProfile,
  validateNetworkProfile,
} from './profile';

describe('defaultNetworkProfile', () => {
  it('est hors ligne et sans relais public', () => {
    expect(defaultNetworkProfile.mode).toBe('offline');
    expect(defaultNetworkProfile.relayUrl).toBeUndefined();
  });
});

describe('networkProfileSchema', () => {
  it('rejette les clés inconnues', () => {
    expect(networkProfileSchema.safeParse({ mode: 'offline', extra: 1 }).success).toBe(false);
  });

  it('rejette un mode inconnu', () => {
    expect(networkProfileSchema.safeParse({ mode: 'wifi' }).success).toBe(false);
  });
});

describe('normalizeNetworkProfile', () => {
  it('conserve relayUrl uniquement en mode user-relay', () => {
    expect(
      normalizeNetworkProfile({ mode: 'user-relay', relayUrl: 'wss://relay.example' }),
    ).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example' });

    expect(normalizeNetworkProfile({ mode: 'offline', relayUrl: 'wss://relay.example' })).toEqual({
      mode: 'offline',
    });

    expect(
      normalizeNetworkProfile({ mode: 'browser-fetch', relayUrl: 'wss://relay.example' }),
    ).toEqual({ mode: 'browser-fetch' });
  });

  it('conserve companionUrl/companionToken uniquement en mode local-companion', () => {
    expect(
      normalizeNetworkProfile({
        mode: 'local-companion',
        companionUrl: 'http://127.0.0.1:37892',
        companionToken: 'abc',
      }),
    ).toEqual({
      mode: 'local-companion',
      companionUrl: 'http://127.0.0.1:37892',
      companionToken: 'abc',
    });

    expect(
      normalizeNetworkProfile({ mode: 'local-companion', relayUrl: 'wss://relay.example' }),
    ).toEqual({ mode: 'local-companion' });

    expect(
      normalizeNetworkProfile({
        mode: 'offline',
        companionUrl: 'http://127.0.0.1:37892',
        companionToken: 'abc',
      }),
    ).toEqual({ mode: 'offline' });

    expect(
      normalizeNetworkProfile({
        mode: 'user-relay',
        relayUrl: 'wss://relay.example',
        companionUrl: 'http://127.0.0.1:37892',
      }),
    ).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example' });
  });

  it('lève une NetworkError sur une entrée invalide', () => {
    expect(() => normalizeNetworkProfile({ mode: 'nope' })).toThrow(NetworkError);
    expect(() => normalizeNetworkProfile(null)).toThrow(NetworkError);
  });
});

describe('validateNetworkProfile', () => {
  it('accepte et nettoie un profil valide', () => {
    const result = validateNetworkProfile({ mode: 'user-relay', relayUrl: 'wss://relay.example' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example' });
  });

  it('retourne les erreurs sans lever', () => {
    const result = validateNetworkProfile({ mode: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.profile).toBeUndefined();
  });
});
