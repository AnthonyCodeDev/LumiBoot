const STORAGE_KEY = 'lumiboot.proxy.session';

export interface PersistedProxySession {
  token: string;
  expiresAt: string;
  proxyUrl: string;
}

/**
 * Stockage de session du bearer d'appairage.
 *
 * Choix P2 sécurité : `sessionStorage` (et non `localStorage`). Le jeton ne
 * survit plus à la fermeture de l'onglet et reste cloisonné à l'onglet courant,
 * ce qui réduit fortement la fenêtre d'exposition en cas de XSS ou d'accès
 * physique ultérieur. La persistance dans l'onglet (F5 compris) est conservée :
 * l'UX de reconnexion n'est pas dégradée.
 *
 * Aucun secret n'est écrit ailleurs. L'ancienne clé `localStorage` d'une version
 * antérieure est purgée à la première interaction (voir {@link purgeLegacyStorage}).
 */
function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Supprime l'ancienne entrée `localStorage` (bearer longue durée des versions
 * précédentes). Aucune migration : l'exposition d'un bearer persistant est
 * précisément ce que cette évolution corrige. Ne lève jamais.
 */
function purgeLegacyStorage(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Accès refusé au stockage : rien à purger.
  }
}

/** Persiste la session d'appairage ; ne lève jamais (quota, accès refusé…). */
export function saveProxySession(session: PersistedProxySession): void {
  purgeLegacyStorage();
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
  // Purge opportuniste de l'ancien bearer persistant avant toute relecture.
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

/** Supprime la session persistée ; ne lève jamais. */
export function clearProxySession(): void {
  purgeLegacyStorage();
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Accès au stockage refusé : ignoré.
  }
}
