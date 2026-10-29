import { DEFAULT_PROXY_URL, type NetworkProfile } from '@lumiboot/vm-network';
import type { ProxyConfig, LumibootConfig } from './schema';
import { loopbackProxyUrl, readEnv } from './environment';

let runtimeConfig: LumibootConfig | null = null;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function setRuntimeConfig(config: LumibootConfig): void {
  runtimeConfig = deepFreeze(config);
}

export function getRuntimeConfig(): LumibootConfig {
  if (runtimeConfig === null) {
    throw new Error(
      'Runtime config unavailable: setRuntimeConfig() must be called before any access.',
    );
  }
  return runtimeConfig;
}

/** Default local proxy config, used when no config is loaded. */
export const DEFAULT_RUNTIME_PROXY: ProxyConfig = Object.freeze({
  enabled: true,
  url: loopbackProxyUrl(readEnv('VITE_PROXY_URL', DEFAULT_PROXY_URL), DEFAULT_PROXY_URL),
});

/** Never throws. */
export function resolveProxyConfig(): ProxyConfig {
  if (runtimeConfig === null) return { ...DEFAULT_RUNTIME_PROXY };
  return runtimeConfig.proxy;
}

/** Profile of a system: `network.systems[systemId]` wins over `network.defaultProfile`. */
export function resolveNetworkProfile(systemId: string): NetworkProfile {
  const config = getRuntimeConfig();
  const explicit = config.network.systems?.[systemId];
  if (explicit !== undefined) return explicit;
  return config.network.defaultProfile;
}
