const STORAGE_KEY = 'lumiboot.companion.session';

export interface PersistedCompanionSession {
  token: string;
  expiresAt: string;
  companionUrl: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Persiste la session d'appairage ; ne lève jamais (quota, accès refusé…). */
export function saveCompanionSession(session: PersistedCompanionSession): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Environnement sans stockage, quota dépassé ou écriture refusée : ignoré.
  }
}

/**
 * Relit la session persistée pour l'URL de compagnon donnée.
 *
 * Renvoie `null` (et nettoie le stockage) si :
 * - le stockage est indisponible ou vide ;
 * - le JSON est corrompu ou le format invalide ;
 * - l'`companionUrl` stocké diffère de celui attendu ;
 * - `expiresAt` est absent, illisible ou déjà dépassé.
 */
export function loadCompanionSession(companionUrl: string): PersistedCompanionSession | null {
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
    clearCompanionSession();
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as PersistedCompanionSession).token !== 'string' ||
    typeof (parsed as PersistedCompanionSession).expiresAt !== 'string' ||
    typeof (parsed as PersistedCompanionSession).companionUrl !== 'string'
  ) {
    clearCompanionSession();
    return null;
  }
  const session = parsed as PersistedCompanionSession;
  if (session.companionUrl !== companionUrl) {
    clearCompanionSession();
    return null;
  }
  const expiry = Date.parse(session.expiresAt);
  if (Number.isNaN(expiry) || expiry <= Date.now()) {
    clearCompanionSession();
    return null;
  }
  return session;
}

/** Supprime la session persistée ; ne lève jamais. */
export function clearCompanionSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Accès au stockage refusé : ignoré.
  }
}
