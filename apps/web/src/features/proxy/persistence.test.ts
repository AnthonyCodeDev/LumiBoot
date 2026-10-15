import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProxySession, loadProxySession, saveProxySession } from './persistence';

const STORAGE_KEY = 'lumiboot.proxy.session';
const URL = 'http://127.0.0.1:37892';

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('proxy persistence', () => {
  it('sauvegarde puis relit une session valide', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    expect(loadProxySession(URL)).toEqual({
      token: 'tok',
      expiresAt: expect.any(String),
      proxyUrl: URL,
    });
  });

  it('expiresAt dépassé → null et nettoyage du stockage', () => {
    saveProxySession({
      token: 'tok',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      proxyUrl: URL,
    });
    expect(loadProxySession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('expiresAt illisible → null et nettoyage', () => {
    saveProxySession({ token: 'tok', expiresAt: 'pas-une-date', proxyUrl: URL });
    expect(loadProxySession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('proxyUrl différent → null et nettoyage', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    expect(loadProxySession('http://127.0.0.1:9999')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('JSON corrompu → null sans lever', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(() => loadProxySession(URL)).not.toThrow();
    expect(loadProxySession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('format invalide (champs manquants) → null et nettoyage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok' }));
    expect(loadProxySession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('absence de localStorage → null sans lever', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() =>
      saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL }),
    ).not.toThrow();
    expect(loadProxySession(URL)).toBeNull();
    expect(() => clearProxySession()).not.toThrow();
  });

  it('clearProxySession supprime la session persistée', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    clearProxySession();
    expect(loadProxySession(URL)).toBeNull();
  });
});
