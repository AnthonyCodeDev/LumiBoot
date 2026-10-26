import type { Architecture, MediaStrategy } from '@lumiboot/contracts';

/**
 * Factual description of a system image.
 *
 * This file declares NO availability status: availability is computed once, in
 * `systems.ts`, through `getEffectiveAvailability`. An image really being
 * present is only read through `imageRef`.
 */
export interface SystemImageDefinition {
  readonly id: string;
  readonly familyId: string;
  readonly architecture: Architecture;
  readonly imageRef?: string;
  /**
   * Media origin: `bundled` (default, served by LumiBoot) or `user-import`
   * (media supplied by the user, never distributed). See docs/windows-7.md.
   */
  readonly mediaStrategy?: MediaStrategy;
  /**
   * True if this system can NOT boot without a local media imported by the
   * user. Drives the honest `resource-required` state as long as the media is
   * absent (no `imageRef` is declared then).
   */
  readonly requiresUserMedia?: boolean;
  readonly requirements: readonly string[];
  readonly licenseNotes?: string;
  readonly integrationNote: string;
}

export const images = [
  {
    id: 'debian-12-i386-image',
    familyId: 'debian',
    architecture: 'i386',
    // Image manifest reference (independent of the engine chosen by the profile).
    // It is the only proof that an image is really built/available.
    imageRef: 'debian-12-i386',
    requirements: ['Modern browser', 'WebAssembly', 'Enough memory'],
    integrationNote: 'First system of the MVP. The Linux image ships in the first batch.',
  },
  {
    id: 'debian-12-i386-desktop-image',
    familyId: 'debian',
    architecture: 'i386',
    // Desktop image built and published. The only proof of presence remains
    // `imageRef`; availability stays DERIVED and also depends on a real
    // validated boot (`validated` on the profile — see docs/debian-desktop.md).
    imageRef: 'debian-12-i386-desktop',
    requirements: [
      'Modern browser',
      'WebAssembly',
      'Enough memory (≥ 1 GiB)',
      'Published graphical image (Xorg)',
    ],
    integrationNote:
      'Graphical variant of Debian 12 (Xorg + Openbox under v86): real boot ' +
      'validated (see docs/debian-desktop.md).',
  },
  {
    id: 'debian-12-i386-xfce-image',
    familyId: 'debian',
    architecture: 'i386',
    // XFCE image built (xfce flavor) and published. The only proof of presence
    // remains `imageRef`; availability stays DERIVED and also depends on a real
    // validated boot (`validated` on the profile — see docs/debian-xfce.md).
    imageRef: 'debian-12-i386-xfce',
    requirements: [
      'Modern browser',
      'WebAssembly',
      'Enough memory (≥ 1 GiB)',
      'XFCE disk (~4 GiB)',
    ],
    integrationNote:
      'Debian 12 variant with the full XFCE desktop environment (Xorg + XFCE under v86): ' +
      'real boot validated (see docs/debian-xfce.md).',
  },
  {
    id: 'ubuntu-18-i386-image',
    familyId: 'ubuntu',
    architecture: 'i386',
    requirements: ['Compatible i386 image', 'Boot tests'],
    integrationNote:
      'Old release kept for plausible browser compatibility. Image to be wired with the Debian batch.',
  },
  {
    id: 'fedora-workstation-image',
    familyId: 'fedora',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'Enough memory', 'x86-64 architecture'],
    integrationNote: 'Base image to pair with an x86-64 browser engine.',
  },
  {
    id: 'mint-x64-image',
    familyId: 'mint',
    architecture: 'x86_64',
    requirements: ['WebAssembly', 'Enough memory', 'x86-64 architecture'],
    integrationNote: 'Base image to pair with an x86-64 browser engine.',
  },
  {
    id: 'windows-7-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    // Operator's 16 GiB RAW disk (images/windows-7-x86/disk.img, ignored by
    // Git) served locally over HTTP Range. No import: it is booted directly by
    // BIOS under v86 (see docs/windows-7.md). "Lite" variant, base (parent) of
    // the Windows 7 variant group.
    imageRef: 'windows-7-x86',
    requirements: [
      'Modern browser with WebAssembly (v86)',
      'Local RAW disk served over HTTP Range (images/windows-7-x86/disk.img)',
      '1024 MiB guest memory',
      'Disk boot (MBR); no Linux kernel',
    ],
    integrationNote:
      'Direct BIOS boot of the local RAW disk through IDE hda (never cdrom), ' +
      'read over HTTP Range via v86. Immutable base, guest writes kept in memory ' +
      'for the duration of the session. "Lite" variant.',
  },
  {
    id: 'windows-7-pro-sp1-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    // Operator's 32 GiB RAW disk (images/windows-7-pro-sp1-x86/disk.img, ignored
    // by Git) served locally over HTTP Range. No import: it is booted directly
    // by BIOS under v86 (see docs/windows-7.md). "Professional" variant of the
    // Windows 7 variant group.
    imageRef: 'windows-7-pro-sp1-x86',
    requirements: [
      'Modern browser with WebAssembly (v86)',
      '32 GiB RAW disk served over HTTP Range (images/windows-7-pro-sp1-x86/disk.img)',
      '1536 MiB guest memory (rounded to 128 KiB by v86)',
      'Disk boot (MBR); no Linux kernel',
    ],
    integrationNote:
      'Direct BIOS boot of the local RAW disk through IDE hda (never cdrom), ' +
      'read over HTTP Range via v86. The disk base is never modified: guest ' +
      'writes stay in memory for the duration of the session.',
  },
  {
    id: 'windows-10-x86-image',
    familyId: 'windows',
    architecture: 'i386',
    // Operator's installed RAW disk (images/windows-10-x86/disk.img, ignored by
    // Git) served locally over HTTP Range and booted by BIOS under v86 — exactly
    // the Windows 7 pipeline. No ISO is distributed: the disk is not imported,
    // it is read directly by the 32-bit x86 emulator. Standalone system (no
    // variant group).
    imageRef: 'windows-10-x86',
    requirements: [
      'Modern browser with WebAssembly (v86, 32-bit)',
      'Local RAW disk served over HTTP Range (images/windows-10-x86/disk.img)',
      '2048 MiB guest memory',
      'Disk boot (MBR); no Linux kernel',
    ],
    licenseNotes:
      'Windows license required (held by the user). No ISO and no proprietary ' +
      'disk is distributed by LumiBoot.',
    integrationNote:
      'Reuses the Windows 7 local RAW disk + 32-bit v86 pipeline (IDE hda, ' +
      'HTTP Range, guest writes kept in memory for the duration of the session). ' +
      'No ISO is distributed. Validated system, booted by BIOS like Windows 7.',
  },
  {
    id: 'windows-11-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    mediaStrategy: 'user-import',
    requirements: ['WebAssembly', 'Virtual TPM depending on configuration', 'Windows license'],
    licenseNotes: 'Windows license required. No proprietary ISO provided.',
    integrationNote: 'Base image to pair with an x86-64 browser engine.',
  },
  {
    id: 'macos-sequoia-image',
    familyId: 'macos',
    architecture: 'arm64',
    requirements: ['WebAssembly', 'Enough memory', 'macOS license compliance'],
    licenseNotes: 'macOS virtualization subject to the Apple license and compatible hardware.',
    integrationNote: 'Base image to pair with an ARM browser engine.',
  },
] as const satisfies readonly SystemImageDefinition[];
