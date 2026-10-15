import { z } from 'zod';
import { networkProfileSchema, type NetworkProfile } from '@lumiboot/vm-network';

/**
 * Schéma de configuration globale LumiBoot (`public/lumiboot.config.json`).
 *
 * Réutilise `networkProfileSchema` de `@lumiboot/vm-network` : les modes et la
 * forme des profils réseau restent définis à un seul endroit. Tous les objets
 * sont `.strict()` : aucune clé inconnue n'est tolérée silencieusement.
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

/** Sortie brute du schéma (avant nettoyage / normalisation). */
export type ParsedLumibootConfig = z.infer<typeof lumibootConfigSchema>;
export type ParsedNetworkConfig = z.infer<typeof networkConfigSchema>;
export type ParsedProxyFileConfig = z.infer<typeof proxyFileSchema>;

/** Configuration réseau normalisée (profils nettoyés, relayUrl cohérent). */
export interface NetworkConfig {
  defaultProfile: NetworkProfile;
  systems?: Record<string, NetworkProfile>;
}

/** Configuration proxy réseau local normalisée (valeurs par défaut appliquées). */
export interface ProxyConfig {
  enabled: boolean;
  url: string;
  downloadManifestUrl?: string;
}

/** Configuration runtime immuable consommée par l'application. */
export interface LumibootConfig {
  version: 1;
  network: NetworkConfig;
  proxy: ProxyConfig;
}
