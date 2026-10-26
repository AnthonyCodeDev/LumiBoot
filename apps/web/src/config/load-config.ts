import {
  DEFAULT_PROXY_URL,
  normalizeNetworkProfile,
  validateProxyUrl,
  validateRelayUrl,
  type NetworkProfile,
} from '@lumiboot/vm-network';
import {
  lumibootConfigSchema,
  type ProxyConfig,
  type LumibootConfig,
  type NetworkConfig,
  type ParsedProxyFileConfig,
  type ParsedNetworkConfig,
} from './schema';

/** Public location of the global config file. */
export const CONFIG_URL = '/lumiboot.config.json';

export type ConfigLoadErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID_JSON'
  | 'CONFIG_INVALID'
  | 'CONFIG_VERSION_UNSUPPORTED'
  | 'CONFIG_INVALID_MODE'
  | 'CONFIG_INVALID_RELAY'
  | 'CONFIG_INVALID_PROXY_URL'
  | 'CONFIG_FORBIDDEN_TOKEN';

/** Typed error: every load failure carries a usable code. */
export class ConfigLoadError extends Error {
  readonly code: ConfigLoadErrorCode;

  constructor(code: ConfigLoadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConfigLoadError';
    this.code = code;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Rejects a `user-relay` profile without an address, or whose WISP address is
 * invalid (non-`wss:` scheme, credentials, fragment…).
 */
function assertRelay(profile: NetworkProfile, label: string): void {
  if (profile.mode !== 'user-relay') return;
  const relayUrl = profile.relayUrl;
  if (relayUrl === undefined || relayUrl.length === 0) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_RELAY',
      `Invalid config: ${label} enables "user-relay" mode without a relay address.`,
    );
  }
  const validation = validateRelayUrl(relayUrl);
  if (!validation.ok) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_RELAY',
      `Invalid config: WISP relay address rejected for ${label} — ${
        validation.error ?? 'invalid address'
      }.`,
    );
  }
}

/**
 * Rejects any token persisted in the public file: `proxyToken` is runtime-only
 * (memory, never `lumiboot.config.json`). Scans the raw JSON recursively because
 * the strict schema would otherwise reject it as a generic `CONFIG_INVALID`,
 * without an explicit security message.
 */
function assertNoProxyToken(raw: unknown): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'proxyToken') return true;
      if (visit(entry)) return true;
    }
    return false;
  };
  if (visit(raw)) {
    throw new ConfigLoadError(
      'CONFIG_FORBIDDEN_TOKEN',
      'Invalid config: "proxyToken" must never appear in the public file "/lumiboot.config.json" (runtime token only, obtained through pairing).',
    );
  }
}

/** Validates the URL of a `local-proxy` profile (loopback only). */
function assertProxyUrl(proxyUrl: string | undefined, label: string): void {
  if (proxyUrl === undefined) return;
  const validation = validateProxyUrl(proxyUrl);
  if (!validation.ok) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_PROXY_URL',
      `Invalid config: local network proxy address rejected for ${label} — ${
        validation.error ?? 'invalid address'
      }.`,
    );
  }
}

/** Normalizes the `proxy` section (defaults applied, URL validated). */
function toProxyConfig(parsed: ParsedProxyFileConfig | undefined): ProxyConfig {
  const url = parsed?.url ?? DEFAULT_PROXY_URL;
  const validation = validateProxyUrl(url);
  if (!validation.ok || validation.url === undefined) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_PROXY_URL',
      `Invalid config: local network proxy address rejected — ${
        validation.error ?? 'invalid address'
      }.`,
    );
  }
  const config: ProxyConfig = {
    enabled: parsed?.enabled ?? true,
    url: validation.url,
  };
  if (parsed?.downloadManifestUrl !== undefined) {
    config.downloadManifestUrl = parsed.downloadManifestUrl;
  }
  return config;
}

/** Cleans validated profiles and checks relays before exposure. */
function toNetworkConfig(parsed: ParsedNetworkConfig): NetworkConfig {
  const defaultProfile = normalizeNetworkProfile(parsed.defaultProfile);
  assertRelay(defaultProfile, 'the default network profile');
  assertProxyUrl(
    defaultProfile.mode === 'local-proxy' ? defaultProfile.proxyUrl : undefined,
    'the default network profile',
  );

  const parsedSystems = parsed.systems;
  if (parsedSystems === undefined) {
    return { defaultProfile };
  }

  const systems: Record<string, NetworkProfile> = {};
  for (const [id, rawProfile] of Object.entries(parsedSystems)) {
    const profile = normalizeNetworkProfile(rawProfile);
    assertRelay(profile, `the "${id}" system`);
    assertProxyUrl(
      profile.mode === 'local-proxy' ? profile.proxyUrl : undefined,
      `the "${id}" system`,
    );
    systems[id] = profile;
  }
  return { defaultProfile, systems };
}

/**
 * Loads the global public config before the React render.
 *
 * Detects the SPA fallback (HTML page served instead of JSON), validates the
 * version, then the schema, then the relay addresses. Never throws an untyped
 * exception: every failure is a `ConfigLoadError`.
 */
export async function loadConfig(fetchImpl: FetchLike = fetch): Promise<LumibootConfig> {
  let response: Response;
  try {
    response = await fetchImpl(CONFIG_URL, { cache: 'no-store' });
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_NOT_FOUND',
      `Config not found: cannot load "${CONFIG_URL}".`,
      { cause },
    );
  }

  if (!response.ok) {
    const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : '';
    throw new ConfigLoadError(
      'CONFIG_NOT_FOUND',
      `Config not found: "${CONFIG_URL}" responded ${response.status}${statusText}.`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Config unreadable: "${CONFIG_URL}" could not be read.`,
      { cause },
    );
  }

  // SPA fallback: the server returns index.html instead of the config file.
  if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Config not found: "${CONFIG_URL}" returned an HTML page (SPA fallback). ` +
        'Check that the file is actually deployed.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_JSON',
      `Config unreadable: "${CONFIG_URL}" is not valid JSON.`,
      { cause },
    );
  }

  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version !== 1) {
    throw new ConfigLoadError(
      'CONFIG_VERSION_UNSUPPORTED',
      `Unsupported config version: ${
        version === undefined ? 'missing' : JSON.stringify(version)
      } (expected: 1).`,
    );
  }

  assertNoProxyToken(raw);

  const result = lumibootConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    if (first !== undefined && first.path.includes('mode')) {
      throw new ConfigLoadError(
        'CONFIG_INVALID_MODE',
        `Unknown network mode in config "${CONFIG_URL}": ${first.message}.`,
      );
    }
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Invalid config in "${CONFIG_URL}": ${first?.message ?? 'unexpected structure'}.`,
    );
  }

  return {
    version: 1,
    network: toNetworkConfig(result.data.network),
    proxy: toProxyConfig(result.data.proxy),
  };
}
