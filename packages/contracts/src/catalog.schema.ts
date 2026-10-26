import { z } from 'zod';

/**
 * OS catalog — validation schemas and inferred types.
 *
 * These schemas are the shared source of truth between the local catalog
 * (`@lumiboot/catalog`) and the Web interface.
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
export const availabilitySchema = z.enum([
  'planned',
  'experimental',
  'ready',
  'unavailable',
  // The engine and the profile are integrated, but the system media (often
  // proprietary) must be supplied by the user: no resource is distributed with
  // LumiBoot. Honest state as long as the media has not been imported.
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

/**
 * Strategy for supplying an image's system media.
 *
 * - `bundled`: the image is built/published and served by LumiBoot;
 * - `user-import`: no image is distributed (license/property); the media is
 *   **supplied locally by the user** from a file they legally hold (see
 *   docs/windows-7.md). The catalog state stays honest (`resource-required`)
 *   as long as that media has not been imported.
 */
export const mediaStrategySchema = z.enum(['bundled', 'user-import']);

/** Disk media format accepted for a user import. */
export const vmMediaFormatSchema = z.enum(['raw', 'iso']);

/**
 * Disk media supplied at runtime for a BIOS boot (without a Linux kernel).
 * `url` is a local blob URL created by the browser, never a remote one.
 */
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
  /**
   * Imported disk media (BIOS boot); absent for a kernel boot
   * (`bzimage`/`initrd`) backed by a published image manifest.
   */
  media: vmMediaSchema.optional(),
  extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** Emulated network card provided to the guest system (`none` = no card). */
export const hardwareNetworkSchema = z.enum(['virtio', 'ne2k', 'none']);

/**
 * Emulated hardware profile, **independent of the execution engine**.
 *
 * It describes what the guest system sees, not how a given emulator implements
 * it: the provider simply TRANSLATES this contract into its engine options
 * (v86 `net_device.type`, etc.) without deciding on behalf of the catalog.
 *
 * Documented defaults (applied by the provider when a field is omitted), chosen
 * to stay factual about what a PC emulated by v86 really exposes:
 * - `network`: `'virtio'` (modern network; v86 also accepts `'ne2k'`/`'none'`);
 * - `machine?`: `'pc'` (v86 only emulates a PC with a standard chipset);
 * - `video?`: `'vga'` (v86 uses a VGA BIOS);
 * - `input?`: `'ps2'` (v86 wires keyboard/mouse to a PS/2 controller);
 * - `disk?`: `'ide'` (v86 exposes the disk as ATA/IDE through `hda`);
 * - `audio?`: `false` (v86 does not emulate a sound card in this version).
 */
export const hardwareProfileSchema = z.object({
  network: hardwareNetworkSchema,
  machine: z.string().min(1).optional(),
  video: z.enum(['std', 'vga']).optional(),
  input: z.enum(['ps2', 'usb']).optional(),
  disk: z.enum(['ide', 'virtio']).optional(),
  audio: z.boolean().optional(),
  /**
   * Enables emulated ACPI. Required by modern NT guests (Windows Vista and
   * later), documented by v86 (`docs/windows-nt.md`). Optional; the provider
   * falls back to `false` when absent.
   */
  acpi: z.boolean().optional(),
});

/** Channel where the guest system proves its boot: serial (default) or VGA. */
export const guestReadinessChannelSchema = z.enum(['serial', 'vga']);

/**
 * Boot proof mode.
 *
 * - `guest-marker` (default): an exact marker emitted by the guest system
 *   (`lumiboot-ready.service` unit on `ttyS0`). Strong proof: the OS is
 *   operational.
 * - `disk-boot`: for an imported media (e.g. Windows) that emits NO LumiBoot
 *   marker. The proof is a **real read of the hard disk** after the emulator
 *   starts (the BIOS/boot loader executes the supplied image). It is an
 *   authentic guest runtime signal, but weaker than a marker: it does not prove
 *   the OS is fully operational. Never simulated.
 */
export const guestReadinessModeSchema = z.enum(['guest-marker', 'disk-boot']);

/**
 * Expected boot proof from the guest system.
 *
 * `marker` is the exact string written by the really booted guest: it must
 * never be produced on the JavaScript side. Documented defaults:
 * `mode` = `'guest-marker'`, `channel` = `'serial'` (ttyS0), `timeoutMs` =
 * 120 000 ms. In `disk-boot` mode, `marker` serves as a documentation
 * identifier (never scanned).
 *
 * `timeoutMs` is a **fallback threshold**, not a failure delay: the marker
 * remains the fast path (earlier transition to `running`); if it does not show
 * up before the deadline, the session is still considered started (fallback).
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
  /**
   * Emulated hardware of this profile. Optional so existing entries keep
   * working; the provider falls back to `network: 'virtio'` when absent.
   */
  hardwareProfile: hardwareProfileSchema.optional(),
  /**
   * Guest boot proof of this profile. Optional; the provider falls back to
   * `marker: 'LUMIBOOT_GUEST_READY'`, channel `'serial'`, 120 000 ms.
   */
  readiness: guestReadinessSchema.optional(),
});

/**
 * An `accentRgb` is stored as "236,66,100" so it can feed
 * `rgba(var(--accent-rgb), x)` in CSS without extra conversion.
 */
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
  /**
   * Origin of the system media. Optional: `'bundled'` by default. Systems with
   * `'user-import'` declare NO `imageRef` as long as the user has not imported
   * their own local media.
   */
  mediaStrategy: mediaStrategySchema.optional(),
  launchProfiles: z.array(launchProfileSchema).min(1),
  requirements: z.array(z.string().min(1)).min(1),
  licenseNotes: z.string().min(1).optional(),
  accent: z.string().min(1),
  accentRgb: accentRgbSchema,
  featured: z.boolean().optional(),
  integrationNote: z.string().min(1),
  /**
   * Id of the parent system of this variant (absent = this system IS the parent
   * or a standalone system).
   */
  variantGroupId: z.string().min(1).optional(),
  /** Short label of the variant (shown in a selector on the system page). */
  variantName: z.string().min(1).optional(),
  /**
   * Display order of the variant within its group (ascending). The smallest
   * value = best variant = default selection. Absent = after the ordered
   * variants (catalog order).
   */
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

/**
 * Documented defaults of the emulated hardware (see
 * {@link hardwareProfileSchema}). Used by providers when a launch profile omits
 * `hardwareProfile`.
 */
export const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  network: 'virtio',
  machine: 'pc',
  video: 'vga',
  input: 'ps2',
  disk: 'ide',
  audio: false,
};

/**
 * Documented defaults of the boot proof (see {@link guestReadinessSchema}).
 * Used when a profile omits `readiness`. `timeoutMs` is a fallback threshold:
 * past it without a marker, the session is considered started, without error.
 */
export const DEFAULT_GUEST_READINESS: GuestReadiness = {
  marker: 'LUMIBOOT_GUEST_READY',
  channel: 'serial',
  timeoutMs: 120_000,
};
