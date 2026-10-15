import { DEFAULT_COMPANION_URL, type NetworkProfile } from '@lumiboot/vm-network';
import type { CompanionConfig, LumibootConfig } from './schema';

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

/** Configuration compagnon par défaut (hors runtime chargé). */
export const DEFAULT_RUNTIME_COMPANION: CompanionConfig = Object.freeze({
  enabled: true,
  url: DEFAULT_COMPANION_URL,
});

/**
 * Configuration compagnon : celle du runtime si chargée, sinon les défauts
 * (compagnon activé, URL loopback par défaut). Ne lève jamais : le panneau
 * compagnon doit rester affichable même sans configuration chargée.
 */
export function resolveCompanionConfig(): CompanionConfig {
  if (runtimeConfig === null) return { ...DEFAULT_RUNTIME_COMPANION };
  return runtimeConfig.companion;
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
