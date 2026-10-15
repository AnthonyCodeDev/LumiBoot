const STORAGE_KEY = 'lumiboot.proxy.session';

export interface PersistedProxySession {
  token: string;
  expiresAt: string;
  proxyUrl: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Persiste la session d'appairage ; ne lève jamais (quota, accès refusé…). */
export function saveProxySession(session: PersistedProxySession): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Environnement sans stockage, quota dépassé ou écriture refusée : ignoré.
  }
}

/**
 * Relit la session persistée pour l'URL de proxy réseau local donnée.
 *
 * Renvoie `null` (et nettoie le stockage) si :
 * - le stockage est indisponible ou vide ;
 * - le JSON est corrompu ou le format invalide ;
 * - l'`proxyUrl` stocké diffère de celui attendu ;
 * - `expiresAt` est absent, illisible ou déjà dépassé.
 */
export function loadProxySession(proxyUrl: string): PersistedProxySession | null {
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

/** Supprime la session persistée ; ne lève jamais. */
export function clearProxySession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Accès au stockage refusé : ignoré.
  }
}
