import type {
  EngineId,
  ExecutionMode,
  GuestReadiness,
  HardwareProfile,
  VMConfiguration,
} from '@lumiboot/contracts';

/**
 * Factual description of a launch profile (image + engine + settings).
 *
 * This file declares NO availability status: availability is computed once, in
 * `systems.ts`. `validated` only attests that a real boot was proven for this
 * image/engine pair.
 *
 * `hardwareProfile` describes the emulated hardware seen by the guest
 * (independent of the engine) and `readiness` the expected boot proof: they are
 * carried by the PROFILE so the provider no longer has to guess them per
 * family/arch.
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
  /** Real boot proven for this profile (E2E tests). */
  readonly validated: boolean;
  readonly featured?: boolean;
  /**
   * Id of the parent system of this variant (absent = this profile IS the
   * parent, or a standalone system). Copied into the `OSDefinition` by
   * `systems.ts`.
   */
  readonly variantGroupId?: string;
  /** Short label of the variant (shown in a selector on the system page). */
  readonly variantName?: string;
  /**
   * Display order of the variant within its group (ascending). The smallest
   * value = best variant = default selection. Absent = after the ordered
   * variants (catalog order). Copied into the `OSDefinition` by `systems.ts`.
   */
  readonly variantOrder?: number;
}

/**
 * Emulated hardware shared by the PC guests of this catalog: standard machine,
 * VGA, PS/2 input, IDE/ATA disk, no audio. Only the network card varies.
 */
function pcHardware(network: HardwareProfile['network']): HardwareProfile {
  return { network, machine: 'pc', video: 'vga', input: 'ps2', disk: 'ide', audio: false };
}

/**
 * Boot proof specific to a system: the marker is the one emitted by
 * `lumiboot-ready.service` on `ttyS0` (serial channel), with a 120 s safety
 * timeout.
 */
function guestReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_GUEST_READY:${systemId}`,
    channel: 'serial',
    timeoutMs: 120_000,
  };
}

/**
 * Boot proof of a system with a graphical interface.
 *
 * The `LUMIBOOT_DESKTOP_READY` marker is emitted only AFTER the X server has
 * actually started (socket + response) AND the graphical session is up (window
 * manager alive). It is distinct from `LUMIBOOT_GUEST_READY` (OS up) and is
 * never produced on the JavaScript side: it comes from the real guest system.
 */
function desktopReadiness(systemId: string): GuestReadiness {
  return {
    marker: `LUMIBOOT_DESKTOP_READY:${systemId}`,
    channel: 'serial',
    // Normal timeout: under software emulation (v86 without acceleration), Xorg
    // and the graphical session take several minutes; 240 s covers the measured
    // boots (see docs/debian-desktop.md, docs/debian-xfce.md).
    timeoutMs: 240_000,
  };
}

/**
 * Boot proof of a system whose disk is started by BIOS (e.g. Windows 7 from a
 * local RAW disk or an imported medium).
 *
 * This system emits NO LumiBoot marker. The proof is a **real read of the hard
 * disk** after the emulator starts (the BIOS/boot loader executes the disk
 * image). `marker` serves as a documentation identifier and is never scanned.
 * The timeout is generous: POST, boot and NT loading take several minutes under
 * software emulation.
 */
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
    // Engine choice and execution settings live in the PROFILE, never in the
    // image: the same Debian disk can thus back several profiles (v86, then
    // another emulator) without duplicating the image.
    configuration: {
      memoryMiB: 512,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Kernel 6.x: native `virtio-net`, marker kept as is.
    hardwareProfile: pcHardware('virtio'),
    readiness: guestReadiness('debian-12-i386'),
    slug: 'debian-12-i386',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    validated: true,
    featured: true,
    // PARENT system of the Debian variant group: it has no `variantGroupId`
    // (it carries the group) but exposes its variant label. CLI is the LEAST
    // promoted variant: highest `variantOrder`.
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
    // Xorg + Openbox use more memory than the console: 1 GiB floor.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Same emulated network card as the console profile (kernel 6.x, `virtio-net`).
    hardwareProfile: pcHardware('virtio'),
    // The Desktop marker is emitted only after X + session actually start.
    readiness: desktopReadiness('debian-12-i386-desktop'),
    slug: 'debian-12-i386-desktop',
    displayName: 'Debian (Desktop)',
    versionLabel: '12 Bookworm · X11',
    // Child variant attached to the console parent `debian-12-i386`.
    variantGroupId: 'debian-12-i386',
    variantName: 'X11',
    variantOrder: 2,
    // Validated by a REAL boot (Xorg + Openbox): see docs/debian-desktop.md.
    validated: true,
    description:
      'The graphical variant of Debian 12: an Xorg + Openbox session right in the browser, validated by a real boot.',
  },
  {
    id: 'debian-12-i386-xfce',
    imageId: 'debian-12-i386-xfce-image',
    engineId: 'v86',
    executionMode: 'browser',
    // Xorg + XFCE session use more memory than the console: 1 GiB floor.
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // Same emulated network card as the other Debian profiles (kernel 6.x, `virtio-net`).
    hardwareProfile: pcHardware('virtio'),
    // The Desktop marker is emitted only after X + XFCE session actually start.
    readiness: desktopReadiness('debian-12-i386-xfce'),
    slug: 'debian-12-i386-xfce',
    displayName: 'Debian (XFCE)',
    versionLabel: '12 Bookworm · XFCE',
    // Child variant attached to the console parent `debian-12-i386`.
    variantGroupId: 'debian-12-i386',
    variantName: 'XFCE',
    // XFCE is the BEST Debian variant: smallest `variantOrder`, so first in the
    // group and selected by default.
    variantOrder: 1,
    // Validated by a REAL boot (Xorg + XFCE session): see docs/debian-xfce.md.
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
    // Kernel 4.15: native `virtio-net`.
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
    // v86 is the only integrated 32-bit x86 browser engine: the Lite variant
    // boots the operator's local RAW disk directly through BIOS, with no media
    // to import and no Linux kernel.
    engineId: 'v86',
    executionMode: 'browser',
    minMemoryMiB: 1024,
    configuration: {
      memoryMiB: 1024,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // NT guest: no virtio drivers, `ne2k` is the common hardware emulated by v86
    // (only `ne2k` and `virtio` exist). ACPI is required by the Vista+ family
    // (see v86 docs/windows-nt.md).
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    // Local disk: the boot is proven by a real disk read.
    readiness: diskBootReadiness('windows-7-x86'),
    slug: 'windows-7-x86',
    // PARENT system of the Windows 7 variant group: no `variantGroupId`. Base
    // name (the dropdown appends `variantName`). Lite is the LEAST promoted
    // variant: highest `variantOrder`.
    displayName: 'Windows 7',
    versionLabel: 'x86',
    variantName: 'Lite',
    variantOrder: 2,
    // Real desktop boot proven (2D VGA canvas under v86, E2E
    // tests/e2e/windows7-desktop.spec.ts, `VM_E2E_ASSETS=1`): the profile is
    // validated, so the derived availability becomes `ready`.
    validated: true,
    description:
      'The "Lite" variant: a slimmed-down Windows 7 x86, booted by BIOS from ' +
      'its local 16 GiB RAW disk, with no installation.',
  },
  {
    id: 'windows-7-pro-sp1-x86',
    imageId: 'windows-7-pro-sp1-x86-image',
    // v86 is the only integrated 32-bit x86 browser engine: Windows 7
    // Professional SP1 x86 boots the operator's local RAW disk directly through
    // BIOS, with no media to import and no Linux kernel.
    engineId: 'v86',
    executionMode: 'browser',
    // v86 rounds `memory_size` to a multiple of 128 KiB and accepts
    // non-power-of-two values: 1536 MiB (installed under QEMU) is accepted and
    // required by the guest.
    minMemoryMiB: 1536,
    configuration: {
      memoryMiB: 1536,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // NT guest: no virtio drivers, `ne2k` is the common hardware emulated by v86
    // (only `ne2k` and `virtio` exist). ACPI is required by the Vista+ family
    // (see v86 docs/windows-nt.md).
    hardwareProfile: { ...pcHardware('ne2k'), acpi: true },
    // Local disk: the boot is proven by a real disk read.
    readiness: diskBootReadiness('windows-7-pro-sp1-x86'),
    slug: 'windows-7-pro-sp1-x86',
    displayName: 'Windows 7 (Professional)',
    versionLabel: 'SP1 · x86',
    // Child variant attached to the Lite parent `windows-7-x86`. Professional
    // is the BEST Windows 7 variant: smallest `variantOrder`, so first in the
    // group and selected by default.
    variantGroupId: 'windows-7-x86',
    variantName: 'Professional',
    variantOrder: 1,
    // Boot proven by a real disk read (`disk-boot` mode, see docs/windows-7.md):
    // the profile is now validated.
    validated: true,
    description:
      'A Windows 7 Professional SP1 x86 session in the browser via v86, ' +
      'booted directly by BIOS from the local 32 GiB RAW disk, with no ' +
      'installation and no media to import.',
  },
  {
    id: 'windows-10-x86',
    imageId: 'windows-10-x86-image',
    // v86 is the only integrated 32-bit x86 browser engine: the x86 variant
    // boots the local RAW disk directly through BIOS, with no media to import
    // and no Linux kernel — same pipeline as Windows 7.
    engineId: 'v86',
    executionMode: 'browser',
    // 2 GiB floor (aligned with the hardware batch): Windows 10 needs more
    // memory than Windows 7. v86 rounds `memory_size` to a multiple of 128 KiB.
    minMemoryMiB: 2048,
    configuration: {
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      bootDevice: 'disk',
    },
    // The shipped Windows 10 image embeds the x86 VirtIO NetKVM driver: we
    // therefore expose `virtio-net`, which emulated v86 supports (device
    // 0x1AF4:0x1041). ACPI is required by the Vista+ family (see v86
    // docs/windows-nt.md).
    hardwareProfile: { ...pcHardware('virtio'), acpi: true },
    // Local disk: the boot is proven by a real disk read (the BIOS/boot loader
    // executes the image), never by a simulated LumiBoot marker.
    readiness: diskBootReadiness('windows-10-x86'),
    slug: 'windows-10-x86',
    // STANDALONE system: Windows 10 x86 belongs to no variant group (v86 only
    // emulates 32-bit x86).
    displayName: 'Windows 10',
    versionLabel: 'x86 (32-bit)',
    // Same validated local-disk pipeline as Windows 7: the profile is validated,
    // so the derived availability becomes `ready`.
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
    description: 'A modern Windows virtual machine built for local execution in the browser.',
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
] as const satisfies readonly LaunchProfileDefinition[];
