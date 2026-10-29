/** Local WISP server on loopback; the VM uses its derived `ws(s)://…/wisp/` URL. */

import type { NetworkMode } from './modes';
import type { NetworkProfile } from './profile';

export const DEFAULT_PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 37892;
export const DEFAULT_PROXY_URL = `http://${DEFAULT_PROXY_HOST}:${DEFAULT_PROXY_PORT}`;

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

/** Loopback `http:`/`https:` only, no userinfo and no fragment. */
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

/** Fallback when `local-proxy` finds no proxy. */
export const DEFAULT_NETWORK_FALLBACK_MODE: NetworkMode = 'browser-fetch';

export interface ProxyAvailability {
  /** Defaults to true. */
  enabled?: boolean;
  /** Connected and paired: the token must be present. */
  connected: boolean;
  proxyUrl?: string;
  proxyToken?: string;
}

/** A connected, paired proxy wins; `local-proxy` without proxy falls back. */
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
