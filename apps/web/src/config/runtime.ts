import type { NetworkProfile } from '@lumiboot/vm-network';
import type { LumibootConfig } from './schema';

let runtimeConfig: LumibootConfig | null = null;

/** Gèle récursivement la configuration : aucune mutation après chargement. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Enregistre la configuration chargée, figée et immuable. */
export function setRuntimeConfig(config: LumibootConfig): void {
  runtimeConfig = deepFreeze(config);
}

/** Renvoie la configuration runtime ou lève si aucune n'est chargée. */
export function getRuntimeConfig(): LumibootConfig {
  if (runtimeConfig === null) {
    throw new Error(
      'Configuration runtime indisponible : setRuntimeConfig() doit être appelé avant tout accès.',
    );
  }
  return runtimeConfig;
}

/**
 * Profil réseau d'un système : priorité au profil spécifique
 * `network.systems[systemId]`, sinon `network.defaultProfile`.
 */
export function resolveNetworkProfile(systemId: string): NetworkProfile {
  const config = getRuntimeConfig();
  const explicit = config.network.systems?.[systemId];
  if (explicit !== undefined) return explicit;
  return config.network.defaultProfile;
}
