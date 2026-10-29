import { z } from 'zod';
import { networkProfileSchema, type NetworkProfile } from '@lumiboot/vm-network';

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

/** Raw schema output, before normalization. */
export type ParsedLumibootConfig = z.infer<typeof lumibootConfigSchema>;
export type ParsedNetworkConfig = z.infer<typeof networkConfigSchema>;
export type ParsedProxyFileConfig = z.infer<typeof proxyFileSchema>;

export interface NetworkConfig {
  defaultProfile: NetworkProfile;
  systems?: Record<string, NetworkProfile>;
}

export interface ProxyConfig {
  enabled: boolean;
  url: string;
  downloadManifestUrl?: string;
}

export interface LumibootConfig {
  version: 1;
  network: NetworkConfig;
  proxy: ProxyConfig;
}
