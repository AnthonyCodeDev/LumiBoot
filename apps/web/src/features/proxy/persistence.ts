const STORAGE_KEY = 'lumiboot.proxy.session';

export interface PersistedProxySession {
  token: string;
  expiresAt: string;
  proxyUrl: string;
}

/** `sessionStorage`, not `localStorage`: the token dies with the tab. */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Removes the legacy `localStorage` bearer. No migration. Never throws. */
function purgeLegacyStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage access refused: nothing to purge.
  }
}

/** Never throws. An unparsable or past deadline is not written: `loadProxySession` would discard it. */
export function saveProxySession(session: PersistedProxySession): void {
  purgeLegacyStorage();
  const store = storage();
  if (store === null) return;
  const expiry = Date.parse(session.expiresAt);
  if (Number.isNaN(expiry) || expiry <= Date.now()) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Environment without storage, exceeded quota or denied write: ignored.
  }
}

/** Returns `null` and clears storage on missing, corrupted, foreign or expired entries. */
export function loadProxySession(proxyUrl: string): PersistedProxySession | null {
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
