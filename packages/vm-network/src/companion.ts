/**
 * Concepts **communs** du compagnon réseau local LumiBoot (aucune dépendance
 * React/Go).
 *
 * Le compagnon est un serveur WISP local exposé sur loopback
 * (`http://127.0.0.1:37892` par défaut). La VM s'y relie via une URL WebSocket
 * `ws(s)://…/wisp/` dérivée de l'URL HTTP(S) du compagnon.
 */

import type { NetworkMode } from './modes';
import type { NetworkProfile } from './profile';

export const DEFAULT_COMPANION_HOST = '127.0.0.1';
export const DEFAULT_COMPANION_PORT = 37892;
export const DEFAULT_COMPANION_URL = `http://${DEFAULT_COMPANION_HOST}:${DEFAULT_COMPANION_PORT}`;

/** Version du protocole WISP requise par le client v86 actuel. */
export const COMPANION_WISP_VERSION = 1;

export const COMPANION_STATES = [
  'not-installed',
  'not-running',
  'permission-required',
  'pairing-required',
  'connecting',
  'connected',
  'error',
  'incompatible',
] as const;

export type CompanionState = (typeof COMPANION_STATES)[number];

export interface CompanionValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

/**
 * Valide une URL de compagnon : `http:`/`https:` loopback uniquement, pas de
 * userinfo ni fragment. Renvoie l'URL normalisée (`URL.href`) en cas de succès.
 */
export function validateCompanionUrl(raw: unknown): CompanionValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Adresse du compagnon invalide : une chaîne est attendue.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Adresse du compagnon vide.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Adresse du compagnon mal formée.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Seuls les protocoles « http: » et « https: » sont autorisés.' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: "Les identifiants (userinfo) ne sont pas autorisés dans l'URL." };
  }

  if (url.hash !== '') {
    return { ok: false, error: 'Le fragment (« #… ») n’est pas autorisé.' };
  }

  if (url.hostname === '') {
    return { ok: false, error: 'Le nom d’hôte est obligatoire.' };
  }

  if (!isLoopbackHostname(url.hostname)) {
    return { ok: false, error: 'Le compagnon doit être une adresse loopback (127.0.0.1, ::1, localhost).' };
  }

  return { ok: true, url: url.href };
}

/**
 * Construit l'URL de relais WISP locale (`ws://`/`wss://…/wisp/`) à partir de
 * l'URL compagnon et d'un jeton optionnel.
 *
 * Ex : `buildCompanionWispUrl('http://127.0.0.1:37892', 'abc')` →
 * `'ws://127.0.0.1:37892/wisp/?token=abc'`.
 *
 * Lève si l'URL compagnon est invalide.
 */
export function buildCompanionWispUrl(companionUrl: string, token?: string): string {
  const validation = validateCompanionUrl(companionUrl);
  if (!validation.ok || validation.url === undefined) {
    throw new Error(validation.error ?? 'Adresse du compagnon invalide.');
  }

  const url = new URL(validation.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/wisp/';
  url.hash = '';
  url.username = '';
  url.password = '';
  if (token !== undefined && token.length > 0) {
    url.search = `?token=${encodeURIComponent(token)}`;
  } else {
    url.search = '';
  }
  return url.href;
}

/** Mode de repli quand `local-companion` est demandé mais que le compagnon est absent. */
export const DEFAULT_NETWORK_FALLBACK_MODE: NetworkMode = 'browser-fetch';

export interface CompanionAvailability {
  /** Le compagnon est-il activé côté config ? Défaut : true. */
  enabled?: boolean;
  /** Connecté ET appairé (le jeton doit être présent). */
  connected: boolean;
  companionUrl?: string;
  companionToken?: string;
}

/**
 * Sélectionne le profil réseau effectif :
 * - compagnon connecté (activé, `connected`, jeton présent) et mode de base ni
 *   `offline` ni `user-relay` → `local-companion` (avec URL + jeton runtime) ;
 * - mode de base `local-companion` sans compagnon → repli `browser-fetch` ;
 * - sinon → mode de base inchangé.
 */
export function selectEffectiveNetworkProfile(
  base: NetworkProfile,
  companion: CompanionAvailability,
): NetworkProfile {
  const enabled = companion.enabled ?? true;
  const explicit = base.mode === 'offline' || base.mode === 'user-relay';
  if (enabled && companion.connected && companion.companionToken && !explicit) {
    return {
      mode: 'local-companion',
      ...(companion.companionUrl === undefined ? {} : { companionUrl: companion.companionUrl }),
      companionToken: companion.companionToken,
    };
  }
  if (base.mode === 'local-companion') {
    return { mode: DEFAULT_NETWORK_FALLBACK_MODE };
  }
  return base;
}
