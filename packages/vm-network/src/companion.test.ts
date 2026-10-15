import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPANION_HOST,
  DEFAULT_COMPANION_PORT,
  DEFAULT_COMPANION_URL,
  buildCompanionWispUrl,
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
