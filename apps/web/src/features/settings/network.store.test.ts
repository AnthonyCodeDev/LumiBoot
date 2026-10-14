import { beforeEach, describe, expect, it } from 'vitest';
import { NETWORK_PROFILE_STORAGE_KEY, useNetworkStore } from './network.store';

function readStoredRaw(): string | null {
  return window.localStorage.getItem(NETWORK_PROFILE_STORAGE_KEY);
}

beforeEach(() => {
  window.localStorage.clear();
  useNetworkStore.getState().reset();
});

describe('network.store', () => {
  it('démarre hors ligne par défaut et ne persiste rien', () => {
    expect(useNetworkStore.getState().profile).toEqual({ mode: 'offline' });
    expect(readStoredRaw()).toBeNull();
  });

  it('persiste le mode sélectionné', () => {
    useNetworkStore.getState().setMode('browser-fetch');
    expect(useNetworkStore.getState().profile).toEqual({ mode: 'browser-fetch' });
    expect(JSON.parse(readStoredRaw() ?? 'null')).toEqual({ mode: 'browser-fetch' });
  });

  it('ne persiste jamais une adresse de relais invalide', () => {
    useNetworkStore.getState().setMode('user-relay');
    const before = readStoredRaw();
    useNetworkStore.getState().setRelayUrl('ws://x');
    expect(useNetworkStore.getState().profile.relayUrl).toBeUndefined();
    expect(readStoredRaw()).toBe(before);
  });

  it('persiste une adresse wss valide en mode user-relay', () => {
    useNetworkStore.getState().setMode('user-relay');
    useNetworkStore.getState().setRelayUrl('wss://relay.example:4000');
    const profile = useNetworkStore.getState().profile;
    expect(profile.mode).toBe('user-relay');
    expect(profile.relayUrl).toContain('wss://relay.example:4000');
    expect(JSON.parse(readStoredRaw() ?? 'null')).toMatchObject({
      mode: 'user-relay',
      relayUrl: expect.stringContaining('wss://relay.example:4000'),
    });
  });

  it('tolère un contenu stocké corrompu en revenant au défaut', () => {
    window.localStorage.setItem(NETWORK_PROFILE_STORAGE_KEY, '{ not json');
    useNetworkStore.getState().reset();
    expect(useNetworkStore.getState().profile).toEqual({ mode: 'offline' });
  });
});
