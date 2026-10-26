import { z } from 'zod';
import { networkProfileSchema, type NetworkProfile } from '@lumiboot/vm-network';

/**
 * LumiBoot global config schema (`public/lumiboot.config.json`).
 *
 * Reuses `networkProfileSchema` from `@lumiboot/vm-network`: network modes and
 * profile shape stay defined in a single place. Every object is `.strict()`: no
 * unknown key is silently tolerated.
 */
export const networkConfigSchema = z
  .object({
    defaultProfile: networkProfileSchema,
    systems: z.record(z.string(), networkProfileSchema).optional(),
  })
  .strict();

export const proxyFileSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().min(1).optional(),
    downloadManifestUrl: z.string().min(1).optional(),
  })
  .strict();

export const lumibootConfigSchema = z
  .object({
    version: z.literal(1),
    network: networkConfigSchema,
    proxy: proxyFileSchema.optional(),
  })
  .strict();

/** Raw schema output (before cleanup / normalization). */
export type ParsedLumibootConfig = z.infer<typeof lumibootConfigSchema>;
export type ParsedNetworkConfig = z.infer<typeof networkConfigSchema>;
export type ParsedProxyFileConfig = z.infer<typeof proxyFileSchema>;

/** Normalized network config (clean profiles, consistent relayUrl). */
export interface NetworkConfig {
  defaultProfile: NetworkProfile;
  systems?: Record<string, NetworkProfile>;
}

/** Normalized local network proxy config (defaults applied). */
export interface ProxyConfig {
  enabled: boolean;
  url: string;
  downloadManifestUrl?: string;
}

/** Immutable runtime config consumed by the application. */
export interface LumibootConfig {
  version: 1;
  network: NetworkConfig;
  proxy: ProxyConfig;
}
