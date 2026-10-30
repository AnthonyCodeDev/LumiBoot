import type {
  DisplayMode,
  EngineId,
  ExecutionMode,
  GuestReadiness,
  HardwareProfile,
  VMConfiguration,
} from '@lumiboot/contracts';

export interface LaunchProfileDefinition {
  readonly id: string;
  readonly imageId: string;
  readonly engineId: EngineId;
  readonly executionMode: ExecutionMode;
  readonly minMemoryMiB: number;
  readonly configuration?: VMConfiguration;
  readonly hardwareProfile: HardwareProfile;
  readonly readiness: GuestReadiness;
  /** `text` = the serial console is the primary view (CLI). */
  readonly displayMode?: DisplayMode;
  readonly slug: string;
  readonly displayName: string;
  readonly versionLabel: string;
  readonly description: string;
  readonly validated: boolean;
  readonly featured?: boolean;
  readonly variantGroupId?: string;
  readonly variantName?: string;
  readonly variantOrder?: number;
}

function pcHardware(network: HardwareProfile['network']): HardwareProfile {
  return { network, machine: 'pc', video: 'vga', input: 'ps2', disk: 'ide', audio: false };
}

function guestReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_GUEST_READY:${systemId}`,
    channel: 'serial',
    timeoutMs: 120_000,
  };
}

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
    displayMode: 'text',
    slug: 'debian-12-i386',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    validated: true,
    featured: true,
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
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('debian-12-i386-desktop'),
    displayMode: 'graphical',
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
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('debian-12-i386-xfce'),
    displayMode: 'graphical',
    slug: 'debian-12-i386-xfce',
    displayName: 'Debian (XFCE)',
    versionLabel: '12 Bookworm · XFCE',
    variantGroupId: 'debian-12-i386',
    variantName: 'XFCE',
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
    minMemoryMiB: 512,
    configuration: {
      memoryMiB: 512,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: { ...guestReadiness('ubuntu-18-i386'), timeoutMs: 240_000 },
    displayMode: 'text',
    slug: 'ubuntu-18-i386',
    displayName: 'Ubuntu',
    versionLabel: '18.04 LTS',
    variantName: 'CLI',
    variantOrder: 3,
    validated: true,
    description:
      'A historical 32-bit release of Ubuntu, booted from a local rootfs by an x86 emulator in the browser.',
  },
  {
    id: 'ubuntu-18-i386-desktop',
    imageId: 'ubuntu-18-i386-desktop-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('ubuntu-18-i386-desktop'),
    displayMode: 'graphical',
    slug: 'ubuntu-18-i386-desktop',
    displayName: 'Ubuntu (Desktop)',
    versionLabel: '18.04 LTS · X11',
    variantGroupId: 'ubuntu-18-i386',
    variantName: 'X11',
    variantOrder: 2,
    validated: true,
    description:
      'The graphical variant of Ubuntu 18.04 LTS: an Xorg session right in the browser, from a locally built rootfs.',
  },
  {
    id: 'ubuntu-18-i386-xfce',
    imageId: 'ubuntu-18-i386-xfce-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: pcHardware('virtio'),
    readiness: desktopReadiness('ubuntu-18-i386-xfce'),
    displayMode: 'graphical',
    slug: 'ubuntu-18-i386-xfce',
    displayName: 'Ubuntu (XFCE)',
    versionLabel: '18.04 LTS · XFCE',
    variantGroupId: 'ubuntu-18-i386',
    variantName: 'XFCE',
    variantOrder: 1,
    validated: true,
    description:
      'The Ubuntu 18.04 LTS variant with the full XFCE desktop environment: an Xorg + XFCE session right in the browser, from a locally built rootfs.',
  },
  {
    id: 'fedora-44-x86-64',
    imageId: 'fedora-44-x86-64-image',
    engineId: 'v64',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 32,
      bootDevice: 'cdrom',
      extra: { v64CpuCores: 2, v64Graphics: 'bochs_vga' },
    },
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    readiness: { ...guestReadiness('fedora-44-x86-64'), timeoutMs: 300_000 },
    displayMode: 'text',
    slug: 'fedora-44-x86-64',
    displayName: 'Fedora',
    versionLabel: '44 · x86-64',
    // XFCE is the default variant (order 1); the CLI comes second, as on Debian/Ubuntu.
    variantName: 'CLI',
    variantOrder: 2,
    validated: true,
    description:
      'A live Fedora 44 x86-64 console, built locally and booted in the browser by the v64 WebAssembly JIT.',
  },
  {
    id: 'fedora-44-x86-64-xfce',
    imageId: 'fedora-44-x86-64-xfce-image',
    engineId: 'v64',
    executionMode: 'browser',
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 32,
      bootDevice: 'cdrom',
      extra: { v64CpuCores: 2, v64Graphics: 'bochs_vga' },
    },
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    readiness: { ...desktopReadiness('fedora-44-x86-64-xfce'), timeoutMs: 300_000 },
    displayMode: 'graphical',
    slug: 'fedora-44-x86-64-xfce',
    displayName: 'Fedora (XFCE)',
    versionLabel: '44 · x86-64',
    variantGroupId: 'fedora-44-x86-64',
    variantName: 'XFCE',
    variantOrder: 1,
    // The ISO is built and published (apps/web/public/images/fedora-44-x86-64-xfce/).
    // Booted for real in Chromium on 2026-10-30: the guest printed
    // LUMIBOOT_DESKTOP_READY:fedora-44-x86-64-xfce and the XFCE desktop appeared
    // on the VGA canvas (1024x768, measured luminance 172/255), recorded by
    // tests/e2e/desktop-fedora-xfce.spec.ts.
    // `bochs_vga` is the adapter that shows that desktop: the guest drives it
    // through bochs-drm + Xorg `modesetting`. `virtio_gpu` also paints, while
    // `vmware_svga` puts the session on the VMware SVGA device, which v64 can
    // only present through its WebGPU renderer: without WebGPU the canvas never
    // leaves the SeaBIOS text mode.
    // Measured locally: DESKTOP_READY ~6 min after start, first painted desktop
    // frame ~4 min later (xfdesktop), so a canvas probe must wait after the marker.
    validated: true,
    description:
      'The Fedora 44 x86-64 variant with the XFCE desktop environment: Xorg + XFCE on tty1, from the live ISO built and published locally.',
  },
  {
    id: 'alpine-3-24-x86-64',
    imageId: 'alpine-3-24-x86-64-image',
    engineId: 'v64',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 32,
      bootDevice: 'cdrom',
      extra: { v64CpuCores: 2, v64Graphics: 'bochs_vga' },
    },
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    readiness: {
      marker: 'lumiboot@lumiboot',
      channel: 'serial',
      timeoutMs: 300_000,
    },
    displayMode: 'text',
    slug: 'alpine-3-24-x86-64',
    displayName: 'Alpine Linux',
    versionLabel: '3.24 · x86-64',
    validated: true,
    description:
      'Alpine Linux 3.24 x86-64 running locally in the browser with the v64 WebAssembly JIT.',
  },
  {
    id: 'windows-7-x86',
    imageId: 'windows-7-x86-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    readiness: diskBootReadiness('windows-7-x86'),
    displayMode: 'graphical',
    slug: 'windows-7-x86',
    displayName: 'Windows 7',
    versionLabel: 'x86',
    variantName: 'Lite',
    variantOrder: 2,
    validated: true,
    description:
      'The "Lite" variant: a slimmed-down Windows 7 x86, booted by BIOS from ' +
      'its local 16 GiB RAW disk, with no installation.',
  },
  {
    id: 'windows-8-1-x86',
    imageId: 'windows-8-1-x86-image',
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: { ...pcHardware('e1000'), acpi: true },
    readiness: diskBootReadiness('windows-8-1-x86'),
    displayMode: 'graphical',
    slug: 'windows-8-1-x86',
    displayName: 'Windows 8.1 Pro',
    versionLabel: 'x86 (32-bit)',
    validated: true,
    description:
      'A Windows 8.1 Pro x86 (32-bit) session in the browser via v86, booted ' +
      'directly by BIOS from the local RAW disk, with no installation and no ' +
      'media to import.',
  },
  {
    id: 'windows-7-pro-sp1-x86',
    imageId: 'windows-7-pro-sp1-x86-image',
    engineId: 'v86',
    executionMode: 'browser',
    // The guest needs 1536 MiB; v86 accepts non-power-of-two memory.
    minMemoryMiB: 1536,
    configuration: {
      memoryMiB: 1536,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    readiness: diskBootReadiness('windows-7-pro-sp1-x86'),
    displayMode: 'graphical',
    slug: 'windows-7-pro-sp1-x86',
    displayName: 'Windows 7 (Professional)',
    versionLabel: 'SP1 · x86',
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
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // The image embeds the x86 VirtIO NetKVM driver.
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    readiness: diskBootReadiness('windows-10-x86'),
    displayMode: 'graphical',
    slug: 'windows-10-x86',
    displayName: 'Windows 10',
    versionLabel: 'x86 (32-bit)',
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
