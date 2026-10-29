import { z } from 'zod';

export const osFamilySchema = z.enum(['linux', 'windows', 'macos', 'custom']);
export const executionModeSchema = z.enum(['browser']);
export const engineIdSchema = z.enum([
  'v86',
  'v64',
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

export const vmMediaFormatSchema = z.enum(['raw', 'iso']);

/** `url` is a local blob URL, never a remote one. */
export const vmMediaSchema = z.object({
  kind: z.literal('disk'),
  url: z.string().min(1),
  size: z.number().int().positive(),
  format: vmMediaFormatSchema,
  /** Stable identity of the imported bytes, used by persistent browser disks. */
  sourceId: z.string().min(1).optional(),
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

export const hardwareNetworkSchema = z.enum(['virtio', 'ne2k', 'e1000', 'none']);

/** Guest-visible hardware; providers only translate it into engine options. */
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

export const guestReadinessChannelSchema = z.enum(['serial', 'vga']);

/** `disk-boot` is a real but weaker proof than `guest-marker`. */
export const guestReadinessModeSchema = z.enum(['guest-marker', 'disk-boot']);

/** `timeoutMs` is diagnostic only: expiry never stops the VM. */
export const guestReadinessSchema = z.object({
  marker: z.string().min(1),
  mode: guestReadinessModeSchema.optional(),
  channel: guestReadinessChannelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const displayModeSchema = z.enum(['text', 'graphical']);

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
  /** `text` = the serial console is the primary view (CLI); absent = graphical. */
  displayMode: displayModeSchema.optional(),
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
  mediaStrategy: mediaStrategySchema.optional(),
  launchProfiles: z.array(launchProfileSchema).min(1),
  requirements: z.array(z.string().min(1)).min(1),
  accent: z.string().min(1),
  accentRgb: accentRgbSchema,
  featured: z.boolean().optional(),
  integrationNote: z.string().min(1),
  /** Parent system id; absent for a parent or standalone system. */
  variantGroupId: z.string().min(1).optional(),
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
export type DisplayMode = z.infer<typeof displayModeSchema>;
export type LaunchProfile = z.infer<typeof launchProfileSchema>;
export type OSDefinition = z.infer<typeof osDefinitionSchema>;

export const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  network: 'virtio',
  machine: 'pc',
  video: 'vga',
  input: 'ps2',
  disk: 'ide',
  audio: false,
};

export const DEFAULT_GUEST_READINESS: GuestReadiness = {
  marker: 'LUMIBOOT_GUEST_READY',
  channel: 'serial',
  timeoutMs: 120_000,
};
