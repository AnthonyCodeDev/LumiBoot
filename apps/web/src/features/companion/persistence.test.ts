import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearCompanionSession,
  loadCompanionSession,
  saveCompanionSession,
} from './persistence';

const STORAGE_KEY = 'lumiboot.companion.session';
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

describe('companion persistence', () => {
  it('sauvegarde puis relit une session valide', () => {
    saveCompanionSession({ token: 'tok', expiresAt: futureIso(), companionUrl: URL });
    expect(loadCompanionSession(URL)).toEqual({
      token: 'tok',
      expiresAt: expect.any(String),
      companionUrl: URL,
    });
  });

  it('expiresAt dépassé → null et nettoyage du stockage', () => {
    saveCompanionSession({
      token: 'tok',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      companionUrl: URL,
    });
    expect(loadCompanionSession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('expiresAt illisible → null et nettoyage', () => {
    saveCompanionSession({ token: 'tok', expiresAt: 'pas-une-date', companionUrl: URL });
    expect(loadCompanionSession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('companionUrl différent → null et nettoyage', () => {
    saveCompanionSession({ token: 'tok', expiresAt: futureIso(), companionUrl: URL });
    expect(loadCompanionSession('http://127.0.0.1:9999')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('JSON corrompu → null sans lever', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(() => loadCompanionSession(URL)).not.toThrow();
    expect(loadCompanionSession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('format invalide (champs manquants) → null et nettoyage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok' }));
    expect(loadCompanionSession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('absence de localStorage → null sans lever', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveCompanionSession({ token: 'tok', expiresAt: futureIso(), companionUrl: URL })).not.toThrow();
    expect(loadCompanionSession(URL)).toBeNull();
    expect(() => clearCompanionSession()).not.toThrow();
  });

  it('clearCompanionSession supprime la session persistée', () => {
    saveCompanionSession({ token: 'tok', expiresAt: futureIso(), companionUrl: URL });
    clearCompanionSession();
    expect(loadCompanionSession(URL)).toBeNull();
  });
});
