import { z } from 'zod';

/**
 * Catalogue d'OS — schémas de validation et types inférés.
 *
 * Ces schémas sont la source de vérité partagée entre le catalogue local
 * (`@lumiboot/catalog`) et l'interface Web.
 */

export const osFamilySchema = z.enum(['linux', 'windows', 'macos']);
export const executionModeSchema = z.enum(['browser']);
export const engineIdSchema = z.enum([
  'v86',
  'wasm-x86',
  'wasm-x86_64',
  'wasm-arm',
  'wasm-powerpc',
  'wasm-68k',
]);
export const availabilitySchema = z.enum(['planned', 'experimental', 'ready', 'unavailable']);
export const architectureSchema = z.enum([
  'i386',
  'x86',
  'x86_64',
  'arm',
  'arm64',
  'powerpc',
  'm68k',
]);

export const vmConfigurationSchema = z.object({
  memoryMiB: z.number().int().positive().optional(),
  vgaMemoryMiB: z.number().int().positive().optional(),
  bootDevice: z.string().min(1).optional(),
  extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const launchProfileSchema = z.object({
  id: z.string().min(1),
  engineId: engineIdSchema,
  executionMode: executionModeSchema,
  minMemoryMiB: z.number().int().positive().optional(),
  featured: z.boolean().optional(),
  configuration: vmConfigurationSchema.optional(),
});

/**
 * Un `accentRgb` est stocké sous la forme "236,66,100" afin d'alimenter
 * `rgba(var(--accent-rgb), x)` en CSS sans conversion supplémentaire.
 */
export const accentRgbSchema = z
  .string()
  .regex(/^\d{1,3},\d{1,3},\d{1,3}$/, 'Format attendu : « r,g,b » (ex. "236,66,100")');

export const osDefinitionSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug : minuscules, chiffres et tirets uniquement'),
  family: osFamilySchema,
  displayName: z.string().min(1),
  versionLabel: z.string().min(1),
  architecture: architectureSchema,
  availability: availabilitySchema,
  description: z.string().min(1),
  iconUrl: z.string().min(1),
  minMemoryMiB: z.number().int().positive().optional(),
  imageRef: z.string().min(1).optional(),
  launchProfiles: z.array(launchProfileSchema).min(1),
  requirements: z.array(z.string().min(1)).min(1),
  licenseNotes: z.string().min(1).optional(),
  accent: z.string().min(1),
  accentRgb: accentRgbSchema,
  featured: z.boolean().optional(),
  integrationNote: z.string().min(1),
});

export const osCatalogSchema = z.array(osDefinitionSchema).min(1);

export type OSFamily = z.infer<typeof osFamilySchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type EngineId = z.infer<typeof engineIdSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type VMConfiguration = z.infer<typeof vmConfigurationSchema>;
export type LaunchProfile = z.infer<typeof launchProfileSchema>;
export type OSDefinition = z.infer<typeof osDefinitionSchema>;
