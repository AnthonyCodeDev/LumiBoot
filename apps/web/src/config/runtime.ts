import { DEFAULT_PROXY_URL, type NetworkProfile } from '@lumiboot/vm-network';
import type { ProxyConfig, LumibootConfig } from './schema';

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

/** Configuration proxy réseau local par défaut (hors runtime chargé). */
export const DEFAULT_RUNTIME_PROXY: ProxyConfig = Object.freeze({
  enabled: true,
  url: DEFAULT_PROXY_URL,
});

/**
 * Configuration proxy réseau local : celle du runtime si chargée, sinon les défauts
 * (proxy réseau local activé, URL loopback par défaut). Ne lève jamais : le panneau
 * proxy réseau local doit rester affichable même sans configuration chargée.
 */
export function resolveProxyConfig(): ProxyConfig {
  if (runtimeConfig === null) return { ...DEFAULT_RUNTIME_PROXY };
  return runtimeConfig.proxy;
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
