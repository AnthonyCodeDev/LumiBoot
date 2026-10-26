/**
 * **Shared** concepts of the LumiBoot local network proxy (no React/Go
 * dependency).
 *
 * The local network proxy is a local WISP server exposed on loopback
 * (`http://127.0.0.1:37892` by default). The VM connects to it through a
 * WebSocket URL `ws(s)://…/wisp/` derived from the HTTP(S) URL of the local
 * network proxy.
 */

import type { NetworkMode } from './modes';
import type { NetworkProfile } from './profile';

export const DEFAULT_PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 37892;
export const DEFAULT_PROXY_URL = `http://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`;

/** WISP protocol version required by the current v86 client. */
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
 * Validates a local network proxy URL: loopback `http:`/`https:` only, no
 * userinfo and no fragment. Returns the normalized URL (`URL.href`) on success.
 */
export function validateProxyUrl(raw: unknown): ProxyValidation {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      error: 'Invalid local network proxy address: a string is expected.',
    };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty local network proxy address.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Malformed local network proxy address.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only the "http:" and "https:" protocols are allowed.' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Credentials (userinfo) are not allowed in the URL.' };
  }

  if (url.hash !== '') {
    return { ok: false, error: 'The fragment ("#…") is not allowed.' };
  }

  if (url.hostname === '') {
    return { ok: false, error: 'The hostname is required.' };
  }

  if (!isLoopbackHostname(url.hostname)) {
    return {
      ok: false,
      error: 'The local network proxy must be a loopback address (127.0.0.1, ::1, localhost).',
    };
  }

  return { ok: true, url: url.href };
}

/**
 * Builds the local WISP relay URL (`ws://`/`wss://…/wisp/`) from the local
 * network proxy URL and an optional token.
 *
 * E.g.: `buildProxyWispUrl('http://127.0.0.1:37892', 'abc')` →
 * `'ws://127.0.0.1:37892/wisp/?token=abc'`.
 *
 * Throws if the local network proxy URL is invalid.
 */
export function buildProxyWispUrl(proxyUrl: string, token?: string): string {
  const validation = validateProxyUrl(proxyUrl);
  if (!validation.ok || validation.url === undefined) {
    throw new Error(validation.error ?? 'Invalid local network proxy address.');
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

/** Fallback mode when `local-proxy` is requested but the local network proxy is absent. */
export const DEFAULT_NETWORK_FALLBACK_MODE: NetworkMode = 'browser-fetch';

export interface ProxyAvailability {
  /** Is the local network proxy enabled in the config? Default: true. */
  enabled?: boolean;
  /** Connected AND paired (the token must be present). */
  connected: boolean;
  proxyUrl?: string;
  proxyToken?: string;
}

/**
 * Selects the effective network profile:
 * - local network proxy connected (enabled, `connected`, token present) and base
 *   mode neither `offline` nor `user-relay` → `local-proxy` (with runtime URL +
 *   token);
 * - base mode `local-proxy` without a local network proxy → `browser-fetch`
 *   fallback;
 * - otherwise → unchanged base mode.
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
