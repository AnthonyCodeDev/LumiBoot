import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPANION_HOST,
  DEFAULT_COMPANION_PORT,
  DEFAULT_COMPANION_URL,
  DEFAULT_NETWORK_FALLBACK_MODE,
  buildCompanionWispUrl,
  selectEffectiveNetworkProfile,
  validateCompanionUrl,
} from './companion';

describe('constantes du compagnon', () => {
  it('expose le loopback et le port par défaut', () => {
    expect(DEFAULT_COMPANION_HOST).toBe('127.0.0.1');
    expect(DEFAULT_COMPANION_PORT).toBe(37892);
    expect(DEFAULT_COMPANION_URL).toBe('http://127.0.0.1:37892');
  });
});

describe('validateCompanionUrl', () => {
  it('accepte les URL loopback http/https', () => {
    expect(validateCompanionUrl('http://127.0.0.1:37892').ok).toBe(true);
    expect(validateCompanionUrl('http://localhost').ok).toBe(true);
    expect(validateCompanionUrl('https://[::1]').ok).toBe(true);
  });

  it('normalise l’URL renvoyée', () => {
    const result = validateCompanionUrl('http://127.0.0.1:37892');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('http://127.0.0.1:37892/');
  });

  it('rejette 0.0.0.0 et les domaines distants', () => {
    expect(validateCompanionUrl('http://0.0.0.0:37892').ok).toBe(false);
    expect(validateCompanionUrl('http://relay.example').ok).toBe(false);
    expect(validateCompanionUrl('https://example.com').ok).toBe(false);
  });

  it('rejette userinfo et fragment', () => {
    expect(validateCompanionUrl('http://user@127.0.0.1:37892').ok).toBe(false);
    expect(validateCompanionUrl('http://user:pass@127.0.0.1:37892').ok).toBe(false);
    expect(validateCompanionUrl('http://127.0.0.1:37892#frag').ok).toBe(false);
  });

  it('rejette les schémas non http(s) et les entrées non textuelles', () => {
    expect(validateCompanionUrl('ws://127.0.0.1:37892').ok).toBe(false);
    expect(validateCompanionUrl('wss://127.0.0.1:37892').ok).toBe(false);
    expect(validateCompanionUrl('').ok).toBe(false);
    expect(validateCompanionUrl(undefined).ok).toBe(false);
    expect(validateCompanionUrl(42).ok).toBe(false);
  });
});

describe('buildCompanionWispUrl', () => {
  it('construit l’URL WISP locale sans jeton', () => {
    expect(buildCompanionWispUrl('http://127.0.0.1:37892')).toBe('ws://127.0.0.1:37892/wisp/');
  });

  it('ajoute le jeton encodé en requête', () => {
    expect(buildCompanionWispUrl('http://127.0.0.1:37892', 'x')).toBe(
      'ws://127.0.0.1:37892/wisp/?token=x',
    );
  });

  it('convertit https en wss', () => {
    expect(buildCompanionWispUrl('https://localhost:37892', 'abc')).toBe(
      'wss://localhost:37892/wisp/?token=abc',
    );
  });

  it('lève sur une URL compagnon invalide', () => {
    expect(() => buildCompanionWispUrl('https://relay.example')).toThrow();
  });
});

describe('selectEffectiveNetworkProfile', () => {
  it('passe en local-companion quand le compagnon est connecté (jeton présent)', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { connected: true, companionUrl: 'http://127.0.0.1:37892', companionToken: 'tok' },
    );
    expect(result).toEqual({
      mode: 'local-companion',
      companionUrl: 'http://127.0.0.1:37892',
      companionToken: 'tok',
    });
  });

  it('replie local-companion sur browser-fetch sans compagnon connecté', () => {
    expect(selectEffectiveNetworkProfile({ mode: 'local-companion' }, { connected: false })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
    expect(selectEffectiveNetworkProfile({ mode: 'local-companion' }, { connected: true })).toEqual({
      mode: DEFAULT_NETWORK_FALLBACK_MODE,
    });
  });

  it('respecte le mode offline même avec un compagnon connecté', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'offline' },
      { connected: true, companionToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'offline' });
  });

  it('respecte le mode user-relay même avec un compagnon connecté', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' },
      { connected: true, companionToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'user-relay', relayUrl: 'wss://relay.example/wisp/' });
  });

  it('conserve le mode de base si le compagnon est désactivé', () => {
    const result = selectEffectiveNetworkProfile(
      { mode: 'browser-fetch' },
      { enabled: false, connected: true, companionToken: 'tok' },
    );
    expect(result).toEqual({ mode: 'browser-fetch' });
  });

  it('laisse browser-fetch inchangé sans compagnon connecté', () => {
    const result = selectEffectiveNetworkProfile({ mode: 'browser-fetch' }, { connected: false });
    expect(result).toEqual({ mode: 'browser-fetch' });
  });
});
