import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProxySession, loadProxySession, saveProxySession } from './persistence';
import { TEST_PROXY_URL } from '../../test/fixtures';

const STORAGE_KEY = 'lumiboot.proxy.session';
const URL = TEST_PROXY_URL;

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe('proxy persistence', () => {
  it('saves then re-reads a valid session', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    expect(loadProxySession(URL)).toEqual({
      token: 'tok',
      expiresAt: expect.any(String),
      proxyUrl: URL,
    });
  });

  it('uses sessionStorage and never persists in localStorage', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('purges a bearer inherited from localStorage (no migration)', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token: 'legacy', expiresAt: futureIso(), proxyUrl: URL }),
    );
    expect(loadProxySession(URL)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('expiresAt in the past → null and storage cleanup', () => {
    saveProxySession({
      token: 'tok',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      proxyUrl: URL,
    });
    expect(loadProxySession(URL)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('unreadable expiresAt → null and cleanup', () => {
    saveProxySession({ token: 'tok', expiresAt: 'not-a-date', proxyUrl: URL });
    expect(loadProxySession(URL)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not write an unreadable expiry at all', () => {
    saveProxySession({ token: 'tok', expiresAt: 'not-a-date', proxyUrl: URL });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not write an expiry that is already past', () => {
    saveProxySession({
      token: 'tok',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      proxyUrl: URL,
    });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('different proxyUrl → null and cleanup', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    expect(loadProxySession(TEST_PROXY_URL.replace(':37892', ':9999'))).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('corrupted JSON → null without throwing', () => {
    sessionStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(() => loadProxySession(URL)).not.toThrow();
    expect(loadProxySession(URL)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('invalid format (missing fields) → null and cleanup', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token: 'tok' }));
    expect(loadProxySession(URL)).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('missing sessionStorage → null without throwing', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() =>
      saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL }),
    ).not.toThrow();
    expect(loadProxySession(URL)).toBeNull();
    expect(() => clearProxySession()).not.toThrow();
  });

  it('clearProxySession removes the persisted session', () => {
    saveProxySession({ token: 'tok', expiresAt: futureIso(), proxyUrl: URL });
    clearProxySession();
    expect(loadProxySession(URL)).toBeNull();
  });
});
