import type {
  Architecture,
  Availability,
  EngineId,
  HardwareNetwork,
  LaunchProfile,
  OSDefinition,
  OSFamily,
} from '@lumiboot/contracts';

export const familyLabels: Record<OSFamily, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  custom: 'Custom',
};

export const engineLabels: Record<EngineId, string> = {
  v86: 'v86 / WebAssembly',
  v64: 'v64 / WebAssembly JIT',
  'wasm-x86': 'WASM x86',
  'wasm-x86_64': 'WASM x86-64',
  'wasm-arm': 'WASM ARM',
  'wasm-powerpc': 'WASM PowerPC',
  'wasm-68k': 'WASM 68k',
};

export const engineShortLabels: Record<EngineId, string> = {
  v86: 'v86',
  v64: 'v64',
  'wasm-x86': 'WASM x86',
  'wasm-x86_64': 'WASM x64',
  'wasm-arm': 'WASM ARM',
  'wasm-powerpc': 'WASM PowerPC',
  'wasm-68k': 'WASM 68k',
};

export const bootDeviceLabels: Record<string, string> = {
  disk: 'Disk (hda)',
  cdrom: 'CD-ROM',
};

export const hardwareNetworkLabels: Record<HardwareNetwork, string> = {
  virtio: 'VirtIO',
  ne2k: 'NE2000',
  e1000: 'Intel E1000',
  none: 'None',
};

export const availabilityLabels: Record<Availability, string> = {
  planned: 'Not ready',
  experimental: 'Experimental',
  ready: 'Available',
  unavailable: 'Unavailable',
  'resource-required': 'Resource required',
};

export function getPrimaryLaunchProfile(
  system: Pick<OSDefinition, 'launchProfiles'>,
): LaunchProfile {
  return system.launchProfiles.find((profile) => profile.featured) ?? system.launchProfiles[0]!;
}

export const architectureLabels: Record<Architecture, string> = {
  i386: '32 bits',
  x86: '32 bits',
  x86_64: '64 bits',
  arm: 'ARM 32 bits',
  arm64: 'ARM 64 bits',
  powerpc: 'PowerPC',
  m68k: '68k',
};

const LEGACY_VERSION_SEGMENTS = new Set([
  'x86',
  'x86 (32-bit)',
  'x86-64',
  'x64',
  '32-bit',
  '64-bit',
  'arm',
  'arm64',
  'experimental',
]);

/** Removes architecture/status fragments formerly embedded in version labels. */
export function cleanVersionLabel(versionLabel: string): string {
  return versionLabel
    .split('·')
    .map((part) => part.trim())
    .filter((part) => !LEGACY_VERSION_SEGMENTS.has(part.toLowerCase()))
    .join(' · ');
}

export function architectureSummary(
  systems: readonly Pick<OSDefinition, 'architecture'>[],
): string {
  return [...new Set(systems.map((system) => architectureLabels[system.architecture]))].join(' · ');
}

export function systemVersionLabel(
  system: Pick<OSDefinition, 'versionLabel' | 'architecture'>,
  variants: readonly Pick<OSDefinition, 'architecture'>[] = [system],
): string {
  const version = cleanVersionLabel(system.versionLabel);
  const architectures = architectureSummary(variants);
  return [version, architectures].filter(Boolean).join(' · ');
}
