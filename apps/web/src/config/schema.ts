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

export const lumibootConfigSchema = z
  .object({
    version: z.literal(1),
    network: networkConfigSchema,
  })
  .strict();

/** Sortie brute du schéma (avant nettoyage / normalisation). */
export type ParsedLumibootConfig = z.infer<typeof lumibootConfigSchema>;
export type ParsedNetworkConfig = z.infer<typeof networkConfigSchema>;

/** Configuration réseau normalisée (profils nettoyés, relayUrl cohérent). */
export interface NetworkConfig {
  defaultProfile: NetworkProfile;
  systems?: Record<string, NetworkProfile>;
}

/** Configuration runtime immuable consommée par l'application. */
export interface LumibootConfig {
  version: 1;
  network: NetworkConfig;
}
