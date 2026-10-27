import { z } from 'zod';

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
export const availabilitySchema = z.enum([
  'planned',
  'experimental',
  'ready',
  'unavailable',
  // Integrated, but the user must supply the media; nothing is distributed.
  'resource-required',
]);
export const architectureSchema = z.enum([
  'i386',
  'x86',
  'x86_64',
  'arm',
  'arm64',
  'powerpc',
  'm68k',
]);

/** `bundled` is served by LumiBoot; `user-import` is supplied by the user. */
export const mediaStrategySchema = z.enum(['bundled', 'user-import']);

/** Disk media format accepted for a user import. */
export const vmMediaFormatSchema = z.enum(['raw', 'iso']);

/** `url` is a local blob URL, never a remote one. */
export const vmMediaSchema = z.object({
  kind: z.literal('disk'),
  url: z.string().min(1),
  size: z.number().int().positive(),
  format: vmMediaFormatSchema,
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});

export const vmConfigurationSchema = z.object({
  memoryMiB: z.number().int().positive().optional(),
  vgaMemoryMiB: z.number().int().positive().optional(),
  bootDevice: z.string().min(1).optional(),
  /** Imported disk media for a BIOS boot; absent for a kernel boot. */
  media: vmMediaSchema.optional(),
  extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** `none` means no card. */
export const hardwareNetworkSchema = z.enum(['virtio', 'ne2k', 'none']);

/**
 * Hardware seen by the guest; each provider only translates it into engine
 * options. Absent fields fall back to `DEFAULT_HARDWARE_PROFILE`.
 */
export const hardwareProfileSchema = z.object({
  network: hardwareNetworkSchema,
  machine: z.string().min(1).optional(),
  video: z.enum(['std', 'vga']).optional(),
  input: z.enum(['ps2', 'usb']).optional(),
  disk: z.enum(['ide', 'virtio']).optional(),
  audio: z.boolean().optional(),
  /** Required by NT guests from Vista on; defaults to `false`. */
  acpi: z.boolean().optional(),
});

/** Channel where the guest proves its boot: serial by default. */
export const guestReadinessChannelSchema = z.enum(['serial', 'vga']);

/**
 * `guest-marker` is a strong proof; `disk-boot` is a real but weaker disk read
 * that never proves a fully operational OS.
 */
export const guestReadinessModeSchema = z.enum(['guest-marker', 'disk-boot']);

/**
 * `marker` comes from the real guest, never from JavaScript. `timeoutMs` is a
 * safety threshold: expiry publishes `BOOT_TIMEOUT` without going running.
 */
export const guestReadinessSchema = z.object({
  marker: z.string().min(1),
  mode: guestReadinessModeSchema.optional(),
  channel: guestReadinessChannelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const launchProfileSchema = z.object({
  id: z.string().min(1),
  engineId: engineIdSchema,
  executionMode: executionModeSchema,
  minMemoryMiB: z.number().int().positive().optional(),
  featured: z.boolean().optional(),
  configuration: vmConfigurationSchema.optional(),
  /** Absent entries fall back to `DEFAULT_HARDWARE_PROFILE`. */
  hardwareProfile: hardwareProfileSchema.optional(),
  /** Absent entries fall back to `DEFAULT_GUEST_READINESS`. */
  readiness: guestReadinessSchema.optional(),
});

/** Stored as "r,g,b" so it can feed `rgba(var(--accent-rgb), x)` directly. */
export const accentRgbSchema = z
  .string()
  .regex(/^\d{1,3},\d{1,3},\d{1,3}$/, 'Expected format: "r,g,b" (e.g. "236,66,100")');

export const osDefinitionSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug: lowercase letters, digits and dashes only'),
  family: osFamilySchema,
  displayName: z.string().min(1),
  versionLabel: z.string().min(1),
  architecture: architectureSchema,
  availability: availabilitySchema,
  description: z.string().min(1),
  iconUrl: z.string().min(1),
  minMemoryMiB: z.number().int().positive().optional(),
  imageRef: z.string().min(1).optional(),
  /** `bundled` by default; `user-import` systems declare no `imageRef`. */
  mediaStrategy: mediaStrategySchema.optional(),
  launchProfiles: z.array(launchProfileSchema).min(1),
  requirements: z.array(z.string().min(1)).min(1),
  licenseNotes: z.string().min(1).optional(),
  accent: z.string().min(1),
  accentRgb: accentRgbSchema,
  featured: z.boolean().optional(),
  integrationNote: z.string().min(1),
  /** Parent system id; absent for a parent or standalone system. */
  variantGroupId: z.string().min(1).optional(),
  /** Shown in the variant selector. */
  variantName: z.string().min(1).optional(),
  /** Ascending; the smallest value is selected by default. */
  variantOrder: z.number().int().optional(),
});

export const osCatalogSchema = z.array(osDefinitionSchema).min(1);

export type OSFamily = z.infer<typeof osFamilySchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type EngineId = z.infer<typeof engineIdSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type MediaStrategy = z.infer<typeof mediaStrategySchema>;
export type VMMedia = z.infer<typeof vmMediaSchema>;
export type VMMediaFormat = z.infer<typeof vmMediaFormatSchema>;
export type VMConfiguration = z.infer<typeof vmConfigurationSchema>;
export type HardwareNetwork = z.infer<typeof hardwareNetworkSchema>;
export type HardwareProfile = z.infer<typeof hardwareProfileSchema>;
export type GuestReadinessChannel = z.infer<typeof guestReadinessChannelSchema>;
export type GuestReadinessMode = z.infer<typeof guestReadinessModeSchema>;
export type GuestReadiness = z.infer<typeof guestReadinessSchema>;
export type LaunchProfile = z.infer<typeof launchProfileSchema>;
export type OSDefinition = z.infer<typeof osDefinitionSchema>;

/** Applied by providers when a profile omits `hardwareProfile`. */
export const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  network: 'virtio',
  machine: 'pc',
  video: 'vga',
  input: 'ps2',
  disk: 'ide',
  audio: false,
};

/** Applied when a profile omits `readiness`. */
export const DEFAULT_GUEST_READINESS: GuestReadiness = {
  marker: 'LUMIBOOT_GUEST_READY',
  channel: 'serial',
  timeoutMs: 120_000,
};
