import type { Architecture, MediaStrategy } from '@lumiboot/contracts';

/** Factual description of a system image; `imageRef` is the only presence proof. */
export interface SystemImageDefinition {
  readonly id: string;
  readonly familyId: string;
  readonly architecture: Architecture;
  readonly imageRef?: string;
  /** `bundled` by default; `user-import` for media supplied by the user. */
  readonly mediaStrategy?: MediaStrategy;
  /** Keeps the state `resource-required` as long as the media is absent. */
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
    // Image manifest reference; the engine is chosen by the profile.
    imageRef: 'debian-12-i386',
    requirements: ['Modern browser', 'WebAssembly', 'Enough memory'],
    integrationNote: 'First system of the MVP. The Linux image ships in the first batch.',
  },
  {
    id: 'debian-12-i386-desktop-image',
    familyId: 'debian',
    architecture: 'i386',
    imageRef: 'debian-12-i386-desktop',
    requirements: [
      'Modern browser',
      'WebAssembly',
      'Enough memory (≥ 1 GiB)',
      'Published graphical image (Xorg)',
    ],
    integrationNote:
      'Graphical variant of Debian 12 (Xorg + Openbox under v86), with a validated real boot.',
  },
  {
    id: 'debian-12-i386-xfce-image',
    familyId: 'debian',
    architecture: 'i386',
    imageRef: 'debian-12-i386-xfce',
    requirements: [
      'Modern browser',
      'WebAssembly',
      'Enough memory (≥ 1 GiB)',
      'XFCE disk (~4 GiB)',
    ],
    integrationNote:
      'Debian 12 variant with the full XFCE desktop environment (Xorg + XFCE under v86), ' +
      'with a validated real boot.',
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
    // 16 GiB RAW disk served over HTTP Range and booted directly by BIOS.
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
    // 32 GiB RAW disk served over HTTP Range and booted directly by BIOS.
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
    // Installed RAW disk, same BIOS pipeline as Windows 7; standalone system.
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
