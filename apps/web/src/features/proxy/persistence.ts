const STORAGE_KEY = 'lumiboot.proxy.session';

export interface PersistedProxySession {
  token: string;
  expiresAt: string;
  proxyUrl: string;
}

/**
 * Session storage for the pairing bearer.
 *
 * P2 security choice: `sessionStorage` (not `localStorage`). The token no longer
 * survives closing the tab and stays scoped to the current tab, which strongly
 * reduces the exposure window in case of XSS or later physical access.
 * Persistence within the tab (F5 included) is preserved: the reconnection UX is
 * not degraded.
 *
 * No secret is written anywhere else. The former `localStorage` key from an
 * earlier version is purged on first interaction (see
 * {@link purgeLegacyStorage}).
 */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Removes the legacy `localStorage` entry (long-lived bearer of previous
 * versions). No migration: exposing a persistent bearer is exactly what this
 * change fixes. Never throws.
 */
function purgeLegacyStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage access refused: nothing to purge.
  }
}

/** Persists the pairing session; never throws (quota, denied access…). */
export function saveProxySession(session: PersistedProxySession): void {
  purgeLegacyStorage();
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Environment without storage, exceeded quota or denied write: ignored.
  }
}

/**
 * Re-reads the persisted session for the given local network proxy URL.
 *
 * Returns `null` (and cleans the storage) when:
 * - storage is unavailable or empty;
 * - the JSON is corrupted or the format invalid;
 * - the stored `proxyUrl` differs from the expected one;
 * - `expiresAt` is missing, unreadable or already past.
 */
export function loadProxySession(proxyUrl: string): PersistedProxySession | null {
  // Opportunistic purge of the legacy persistent bearer before any re-read.
  purgeLegacyStorage();
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearProxySession();
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as PersistedProxySession).token !== 'string' ||
    typeof (parsed as PersistedProxySession).expiresAt !== 'string' ||
    typeof (parsed as PersistedProxySession).proxyUrl !== 'string'
  ) {
    clearProxySession();
    return null;
  }
  const session = parsed as PersistedProxySession;
  if (session.proxyUrl !== proxyUrl) {
    clearProxySession();
    return null;
  }
  const expiry = Date.parse(session.expiresAt);
  if (Number.isNaN(expiry) || expiry <= Date.now()) {
    clearProxySession();
    return null;
  }
  return session;
}

/** Removes the persisted session; never throws. */
export function clearProxySession(): void {
  purgeLegacyStorage();
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Storage access refused: ignored.
  }
}
