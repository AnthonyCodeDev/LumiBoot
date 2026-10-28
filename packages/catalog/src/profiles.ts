import type {
  EngineId,
  ExecutionMode,
  GuestReadiness,
  HardwareProfile,
  VMConfiguration,
} from '@lumiboot/contracts';

/**
 * Launch settings for one image; availability is computed in `systems.ts`.
 */
export interface LaunchProfileDefinition {
  readonly id: string;
  readonly imageId: string;
  readonly engineId: EngineId;
  readonly executionMode: ExecutionMode;
  readonly minMemoryMiB: number;
  readonly configuration?: VMConfiguration;
  readonly hardwareProfile: HardwareProfile;
  readonly readiness: GuestReadiness;
  readonly slug: string;
  readonly displayName: string;
  readonly versionLabel: string;
  readonly description: string;
  /** Real boot proven by the E2E suite. */
  readonly validated: boolean;
  readonly featured?: boolean;
  /** Parent system id; absent for a parent or standalone system. */
  readonly variantGroupId?: string;
  /** Shown in the variant selector. */
  readonly variantName?: string;
  /** Ascending order; the smallest value is selected by default. */
  readonly variantOrder?: number;
}

function pcHardware(network: HardwareProfile['network']): HardwareProfile {
  return { network, machine: 'pc', video: 'vga', input: 'ps2', disk: 'ide', audio: false };
}

/** Marker emitted by `lumiboot-ready.service`; 120 s safety timeout. */
function guestReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_GUEST_READY:${systemId}`,
    channel: 'serial',
    timeoutMs: 120_000,
  };
}

/** Marker emitted once X and the window manager are actually up. */
function desktopReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_DESKTOP_READY:${systemId}`,
    channel: 'serial',
    // Slow under software emulation; 240 s covers measured boots.
    timeoutMs: 240_000,
  };
}

/** BIOS disk boot: no marker is emitted, `marker` is documentation only. */
function diskBootReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_DISK_BOOT:${systemId}`,
    mode: 'disk-boot',
    channel: 'vga',
    timeoutMs: 300_000,
  };
}

export const launchProfiles = [
  {
    id: 'debian-12-i386',
    imageId: 'debian-12-i386-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 128,
    configuration: {
      memoryMiB: 512,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('debian-12-i386'),
    slug: 'debian-12-i386',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    validated: true,
    featured: true,
    // Parent of the Debian group; CLI is the least promoted variant.
    variantName: 'CLI',
    variantOrder: 3,
    description:
      'A stable, flexible Linux distribution, ideal for discovering a real operating system in the browser.',
  },
  {
    id: 'debian-12-i386-desktop',
    imageId: 'debian-12-i386-desktop-image',
    engineId: 'v86',
    executionMode: 'browser',
    // Xorg + Openbox: 1 GiB floor.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('debian-12-i386-desktop'),
    slug: 'debian-12-i386-desktop',
    displayName: 'Debian (Desktop)',
    versionLabel: '12 Bookworm · X11',
    variantGroupId: 'debian-12-i386',
    variantName: 'X11',
    variantOrder: 2,
    validated: true,
    description:
      'The graphical variant of Debian 12: an Xorg + Openbox session right in the browser, validated by a real boot.',
  },
  {
    id: 'debian-12-i386-xfce',
    imageId: 'debian-12-i386-xfce-image',
    engineId: 'v86',
    executionMode: 'browser',
    // Xorg + XFCE: 1 GiB floor.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('debian-12-i386-xfce'),
    slug: 'debian-12-i386-xfce',
    displayName: 'Debian (XFCE)',
    versionLabel: '12 Bookworm · XFCE',
    variantGroupId: 'debian-12-i386',
    variantName: 'XFCE',
    // Best Debian variant: smallest `variantOrder`.
    variantOrder: 1,
    validated: true,
    description:
      'The Debian 12 variant with the full XFCE desktop environment: an Xorg + XFCE session right in the browser, validated by a real boot.',
  },
  {
    id: 'ubuntu-18-i386',
    imageId: 'ubuntu-18-i386-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 256,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'cdrom',
    },
    // Kernel 4.15 has a native `virtio-net` driver.
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('ubuntu-18-i386'),
    slug: 'ubuntu-18-i386',
    displayName: 'Ubuntu',
    versionLabel: '18.04 LTS',
    validated: false,
    description: 'A historical 32-bit release of Ubuntu, run by an x86 emulator in the browser.',
  },
  {
    id: 'fedora-workstation',
    imageId: 'fedora-workstation-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('fedora-workstation'),
    slug: 'fedora-workstation',
    displayName: 'Fedora',
    versionLabel: 'Workstation · x64',
    validated: false,
    description: 'A modern Linux desktop environment, run by an x86-64 browser engine.',
  },
  {
    id: 'mint-x64',
    imageId: 'mint-x64-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('mint-x64'),
    slug: 'mint-x64',
    displayName: 'Linux Mint',
    versionLabel: 'Cinnamon · x64',
    validated: false,
    description: 'A classic, approachable Linux desktop, launched in the browser.',
  },
  {
    id: 'windows-7-x86',
    imageId: 'windows-7-x86-image',
    // v86 is the only integrated 32-bit x86 browser engine.
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // NT guest: no virtio drivers, so `ne2k`; Vista+ requires ACPI.
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    readiness: diskBootReadiness('windows-7-x86'),
    slug: 'windows-7-x86',
    // Parent of the Windows 7 group; Lite is the least promoted variant.
    displayName: 'Windows 7',
    versionLabel: 'x86',
    variantName: 'Lite',
    variantOrder: 2,
    // Real desktop boot proven by the E2E suite.
    validated: true,
    description:
      'The "Lite" variant: a slimmed-down Windows 7 x86, booted by BIOS from ' +
      'its local 16 GiB RAW disk, with no installation.',
  },
  {
    id: 'windows-7-pro-sp1-x86',
    imageId: 'windows-7-pro-sp1-x86-image',
    // v86 is the only integrated 32-bit x86 browser engine.
    engineId: 'v86',
    executionMode: 'browser',
    // The guest needs 1536 MiB; v86 accepts non-power-of-two memory.
    minMemoryMiB: 1536,
    configuration: {
      memoryMiB: 1536,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // NT guest: no virtio drivers, so `ne2k`; Vista+ requires ACPI.
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    readiness: diskBootReadiness('windows-7-pro-sp1-x86'),
    slug: 'windows-7-pro-sp1-x86',
    displayName: 'Windows 7 (Professional)',
    versionLabel: 'SP1 · x86',
    // Professional is the best Windows 7 variant: smallest `variantOrder`.
    variantGroupId: 'windows-7-x86',
    variantName: 'Professional',
    variantOrder: 1,
    validated: true,
    description:
      'A Windows 7 Professional SP1 x86 session in the browser via v86, ' +
      'booted directly by BIOS from the local 32 GiB RAW disk, with no ' +
      'installation and no media to import.',
  },
  {
    id: 'windows-10-x86',
    imageId: 'windows-10-x86-image',
    // v86 is the only integrated 32-bit x86 browser engine.
    engineId: 'v86',
    executionMode: 'browser',
    // 2 GiB floor: Windows 10 needs more memory than Windows 7.
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // The image embeds the x86 VirtIO NetKVM driver; Vista+ requires ACPI.
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    readiness: diskBootReadiness('windows-10-x86'),
    slug: 'windows-10-x86',
    // Standalone system: no variant group.
    displayName: 'Windows 10',
    versionLabel: 'x86 (32-bit)',
    // Same validated local-disk pipeline as Windows 7.
    validated: true,
    description:
      'A Windows 10 x86 (32-bit) session in the browser via v86, booted ' +
      'directly by BIOS from the local RAW disk, with no installation and no ' +
      'media to import.',
  },
  {
    id: 'windows-11-x64',
    imageId: 'windows-11-x64-image',
    engineId: 'wasm-x86_64',
    executionMode: 'browser',
    minMemoryMiB: 4096,
    configuration: {
      memoryMiB: 4096,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('windows-11-x64'),
    slug: 'windows-11-x64',
    displayName: 'Windows 11',
    versionLabel: '64-bit',
    validated: false,
    description: 'Not developed yet: no x86-64 browser engine is integrated.',
  },
  {
    id: 'macos-sequoia',
    imageId: 'macos-sequoia-image',
    engineId: 'wasm-arm',
    executionMode: 'browser',
    minMemoryMiB: 8192,
    configuration: {
      memoryMiB: 8192,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('macos-sequoia'),
    slug: 'macos-sequoia',
    displayName: 'macOS',
    versionLabel: 'Sequoia · Apple Silicon',
    validated: false,
    description: 'A macOS session built for an ARM-capable browser engine.',
  },
  {
    id: 'custom-image',
    imageId: 'custom-image-i386',
    // v86 is the only integrated 32-bit x86 browser engine.
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 512,
    // No boot device: a RAW/IMG arrives as `hda`, a bootable ISO as a CD-ROM.
    configuration: {
      memoryMiB: 512,
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('custom-image'),
    slug: 'custom-image',
    displayName: 'Custom image',
    versionLabel: 'ISO · IMG · RAW',
    validated: false,
    description:
      'Start a local disk media you own (.iso, .img, .raw) in the browser, with no installation.',
  },
] as const satisfies readonly LaunchProfileDefinition[];
