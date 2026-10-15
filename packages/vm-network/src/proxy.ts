/**
 * Concepts **communs** du proxy réseau local LumiBoot (aucune dépendance
 * React/Go).
 *
 * Le proxy réseau local est un serveur WISP local exposé sur loopback
 * (`http://127.0.0.1:37892` par défaut). La VM s'y relie via une URL WebSocket
 * `ws(s)://…/wisp/` dérivée de l'URL HTTP(S) du proxy réseau local.
 */

import type { NetworkMode } from './modes';
import type { NetworkProfile } from './profile';

export const DEFAULT_PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 37892;
export const DEFAULT_PROXY_URL = `http://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`;

/** Version du protocole WISP requise par le client v86 actuel. */
export const PROXY_WISP_VERSION = 1;

export const PROXY_STATES = [
  'not-installed',
  'not-running',
  'permission-required',
  'pairing-required',
  'connecting',
  'connected',
  'error',
  'incompatible',
] as const;

export type ProxyState = (typeof PROXY_STATES)[number];

export interface ProxyValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

/**
 * Valide une URL de proxy réseau local : `http:`/`https:` loopback uniquement, pas de
 * userinfo ni fragment. Renvoie l'URL normalisée (`URL.href`) en cas de succès.
 */
export function validateProxyUrl(raw: unknown): ProxyValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Adresse du proxy réseau local invalide : une chaîne est attendue.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Adresse du proxy réseau local vide.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Adresse du proxy réseau local mal formée.' };
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
    return { ok: false, error: 'Le proxy réseau local doit être une adresse loopback (127.0.0.1, ::1, localhost).' };
  }

  return { ok: true, url: url.href };
}

/**
 * Construit l'URL de relais WISP locale (`ws://`/`wss://…/wisp/`) à partir de
 * l'URL proxy réseau local et d'un jeton optionnel.
 *
 * Ex : `buildProxyWispUrl('http://127.0.0.1:37892', 'abc')` →
 * `'ws://127.0.0.1:37892/wisp/?token=abc'`.
 *
 * Lève si l'URL proxy réseau local est invalide.
 */
export function buildProxyWispUrl(proxyUrl: string, token?: string): string {
  const validation = validateProxyUrl(proxyUrl);
  if (!validation.ok || validation.url === undefined) {
    throw new Error(validation.error ?? 'Adresse du proxy réseau local invalide.');
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

/** Mode de repli quand `local-proxy` est demandé mais que le proxy réseau local est absent. */
export const DEFAULT_NETWORK_FALLBACK_MODE: NetworkMode = 'browser-fetch';

export interface ProxyAvailability {
  /** Le proxy réseau local est-il activé côté config ? Défaut : true. */
  enabled?: boolean;
  /** Connecté ET appairé (le jeton doit être présent). */
  connected: boolean;
  proxyUrl?: string;
  proxyToken?: string;
}

/**
 * Sélectionne le profil réseau effectif :
 * - proxy réseau local connecté (activé, `connected`, jeton présent) et mode de base ni
 *   `offline` ni `user-relay` → `local-proxy` (avec URL + jeton runtime) ;
 * - mode de base `local-proxy` sans proxy réseau local → repli `browser-fetch` ;
 * - sinon → mode de base inchangé.
 */
export function selectEffectiveNetworkProfile(
  base: NetworkProfile,
  proxy: ProxyAvailability,
): NetworkProfile {
  const enabled = proxy.enabled ?? true;
  const explicit = base.mode === 'offline' || base.mode === 'user-relay';
  if (enabled && proxy.connected && proxy.proxyToken && !explicit) {
    return {
      mode: 'local-proxy',
      ...(proxy.proxyUrl === undefined ? {} : { proxyUrl: proxy.proxyUrl }),
      proxyToken: proxy.proxyToken,
    };
  }
  if (base.mode === 'local-proxy') {
    return { mode: DEFAULT_NETWORK_FALLBACK_MODE };
  }
  return base;
}
