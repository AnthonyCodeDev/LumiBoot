import { validateProxyUrl } from '@lumiboot/vm-network';

/** Vite inlines `import.meta.env`; nothing else from `process.env` reaches the browser. */
const ENV: ImportMetaEnv = import.meta.env;

/** Reads a client variable, trimmed; a blank or missing value yields `fallback`. */
export function readEnv(name: keyof ImportMetaEnv, fallback: string): string {
  const value = ENV[name];
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/** Accepts only a same-origin absolute path; anything else falls back. */
export function sameOriginPath(value: string, fallback: string): string {
  if (value.length === 0) return fallback;
  if (/\s/.test(value)) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}

/** Accepts only a loopback `http(s)` proxy URL (no userinfo, no fragment). */
export function loopbackProxyUrl(value: string, fallback: string): string {
  return validateProxyUrl(value).ok ? value.trim() : fallback;
}

/** Accepts only an absolute `https:` URL without userinfo or whitespace. */
export function httpsUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  if (/\s/.test(trimmed)) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fallback;
  }
  if (parsed.protocol !== 'https:') return fallback;
  if (parsed.username.length > 0 || parsed.password.length > 0) return fallback;
  return trimmed;
}

const DEFAULT_DISCORD_INVITE_URL = 'https://discord.gg/HcqduKt';

/** Public `https:` link, never carries credentials. */
export const DISCORD_INVITE_URL = httpsUrl(
  readEnv('VITE_DISCORD_INVITE_URL', DEFAULT_DISCORD_INVITE_URL),
  DEFAULT_DISCORD_INVITE_URL,
);
