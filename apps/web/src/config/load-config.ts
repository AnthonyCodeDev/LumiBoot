import {
  DEFAULT_COMPANION_URL,
  normalizeNetworkProfile,
  validateCompanionUrl,
  validateRelayUrl,
  type NetworkProfile,
} from '@lumiboot/vm-network';
import {
  lumibootConfigSchema,
  type CompanionConfig,
  type LumibootConfig,
  type NetworkConfig,
  type ParsedCompanionFileConfig,
  type ParsedNetworkConfig,
} from './schema';

/** Emplacement public du fichier de configuration globale. */
export const CONFIG_URL = '/lumiboot.config.json';

export type ConfigLoadErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID_JSON'
  | 'CONFIG_INVALID'
  | 'CONFIG_VERSION_UNSUPPORTED'
  | 'CONFIG_INVALID_MODE'
  | 'CONFIG_INVALID_RELAY'
  | 'CONFIG_INVALID_COMPANION_URL'
  | 'CONFIG_FORBIDDEN_TOKEN';

/** Erreur typée : tout échec de chargement porte un code exploitable. */
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
 * Refuse un profil `user-relay` sans adresse ou dont l'adresse WISP est
 * invalide (schéma non `wss:`, identifiants, fragment…).
 */
function assertRelay(profile: NetworkProfile, label: string): void {
  if (profile.mode !== 'user-relay') return;
  const relayUrl = profile.relayUrl;
  if (relayUrl === undefined || relayUrl.length === 0) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_RELAY',
      `Configuration invalide : ${label} active le mode « user-relay » sans adresse de relais.`,
    );
  }
  const validation = validateRelayUrl(relayUrl);
  if (!validation.ok) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_RELAY',
      `Configuration invalide : adresse de relais WISP rejetée pour ${label} — ${
        validation.error ?? 'adresse invalide'
      }.`,
    );
  }
}

/**
 * Refuse tout jeton persisté dans le fichier public : `companionToken` est
 * runtime uniquement (mémoire, jamais `lumiboot.config.json`). Balaye
 * récursivement le JSON brut car le schéma strict le rejetterait sinon en
 * `CONFIG_INVALID` générique, sans message de sécurité explicite.
 */
function assertNoCompanionToken(raw: unknown): void {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'companionToken') return true;
      if (visit(entry)) return true;
    }
    return false;
  };
  if (visit(raw)) {
    throw new ConfigLoadError(
      'CONFIG_FORBIDDEN_TOKEN',
      'Configuration invalide : « companionToken » ne doit jamais figurer dans le fichier public « /lumiboot.config.json » (jeton runtime uniquement, obtenu par appairage).',
    );
  }
}

/** Valide l'URL d'un profil `local-companion` (loopback uniquement). */
function assertCompanionUrl(companionUrl: string | undefined, label: string): void {
  if (companionUrl === undefined) return;
  const validation = validateCompanionUrl(companionUrl);
  if (!validation.ok) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_COMPANION_URL',
      `Configuration invalide : adresse du compagnon rejetée pour ${label} — ${
        validation.error ?? 'adresse invalide'
      }.`,
    );
  }
}

/** Normalise la section `companion` (défauts appliqués, URL validée). */
function toCompanionConfig(parsed: ParsedCompanionFileConfig | undefined): CompanionConfig {
  const url = parsed?.url ?? DEFAULT_COMPANION_URL;
  const validation = validateCompanionUrl(url);
  if (!validation.ok || validation.url === undefined) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_COMPANION_URL',
      `Configuration invalide : adresse du compagnon rejetée — ${
        validation.error ?? 'adresse invalide'
      }.`,
    );
  }
  const config: CompanionConfig = {
    enabled: parsed?.enabled ?? true,
    url: validation.url,
  };
  if (parsed?.downloadManifestUrl !== undefined) {
    config.downloadManifestUrl = parsed.downloadManifestUrl;
  }
  return config;
}

/** Nettoie les profils validés et vérifie les relais avant exposition. */
function toNetworkConfig(parsed: ParsedNetworkConfig): NetworkConfig {
  const defaultProfile = normalizeNetworkProfile(parsed.defaultProfile);
  assertRelay(defaultProfile, 'le profil réseau par défaut');
  assertCompanionUrl(
    defaultProfile.mode === 'local-companion' ? defaultProfile.companionUrl : undefined,
    'le profil réseau par défaut',
  );

  const parsedSystems = parsed.systems;
  if (parsedSystems === undefined) {
    return { defaultProfile };
  }

  const systems: Record<string, NetworkProfile> = {};
  for (const [id, rawProfile] of Object.entries(parsedSystems)) {
    const profile = normalizeNetworkProfile(rawProfile);
    assertRelay(profile, `le système « ${id} »`);
    assertCompanionUrl(
      profile.mode === 'local-companion' ? profile.companionUrl : undefined,
      `le système « ${id} »`,
    );
    systems[id] = profile;
  }
  return { defaultProfile, systems };
}

/**
 * Charge la configuration globale publique avant le rendu React.
 *
 * Détecte le repli SPA (page HTML servie à la place du JSON), valide la
 * version, le schéma puis les adresses de relais. Ne lève jamais d'exception
 * non typée : tout échec est un `ConfigLoadError`.
 */
export async function loadConfig(fetchImpl: FetchLike = fetch): Promise<LumibootConfig> {
  let response: Response;
  try {
    response = await fetchImpl(CONFIG_URL, { cache: 'no-store' });
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_NOT_FOUND',
      `Configuration introuvable : impossible de charger « ${CONFIG_URL} ».`,
      { cause },
    );
  }

  if (!response.ok) {
    const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : '';
    throw new ConfigLoadError(
      'CONFIG_NOT_FOUND',
      `Configuration introuvable : « ${CONFIG_URL} » a répondu ${response.status}${statusText}.`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Configuration illisible : « ${CONFIG_URL} » n'a pas pu être lu.`,
      { cause },
    );
  }

  // Repli SPA : le serveur renvoie index.html au lieu du fichier de config.
  if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Configuration introuvable : « ${CONFIG_URL} » a renvoyé une page HTML (repli SPA). ` +
        'Vérifiez que le fichier est bien déployé.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigLoadError(
      'CONFIG_INVALID_JSON',
      `Configuration illisible : « ${CONFIG_URL} » n'est pas un JSON valide.`,
      { cause },
    );
  }

  const version =
    typeof raw === 'object' && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version !== 1) {
    throw new ConfigLoadError(
      'CONFIG_VERSION_UNSUPPORTED',
      `Version de configuration non prise en charge : ${
        version === undefined ? 'absente' : JSON.stringify(version)
      } (attendu : 1).`,
    );
  }

  assertNoCompanionToken(raw);

  const result = lumibootConfigSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    if (first !== undefined && first.path.includes('mode')) {
      throw new ConfigLoadError(
        'CONFIG_INVALID_MODE',
        `Mode réseau inconnu dans la configuration « ${CONFIG_URL} » : ${first.message}.`,
      );
    }
    throw new ConfigLoadError(
      'CONFIG_INVALID',
      `Configuration invalide dans « ${CONFIG_URL} » : ${
        first?.message ?? 'structure inattendue'
      }.`,
    );
  }

  return {
    version: 1,
    network: toNetworkConfig(result.data.network),
    companion: toCompanionConfig(result.data.companion),
  };
}
