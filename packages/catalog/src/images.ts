import type { Architecture, MediaStrategy } from '@lumiboot/contracts';

/** Factual description of a system image; `imageRef` is the only presence proof. */
export interface SystemImageDefinition {
  readonly id: string;
  readonly familyId: string;
  readonly architecture: Architecture;
  readonly imageRef?: string;
  readonly mediaStrategy?: MediaStrategy;
  readonly requiresUserMedia?: boolean;
  readonly requirements: readonly string[];
  readonly integrationNote: string;
}

export const images = [
  {
    id: 'alpine-3-24-x86-64-image',
    familyId: 'alpine',
    architecture: 'x86_64',
    imageRef: 'alpine-3-24-x86-64',
    requirements: [
      'Modern browser with WebAssembly',
      '1024 MiB guest memory',
      'Cross-origin isolation for parallel host threads',
      'Official Alpine 3.24.0 virt ISO prepared locally',
    ],
    integrationNote:
      'Official Alpine 3.24.0 x86_64 virt ISO, pinned by SHA-256 and booted through v64 with a reproducible LumiBoot autologin overlay. Two guest cores use parallel Workers when cross-origin isolation is available and cooperative scheduling otherwise.',
  },
  {
    id: 'debian-12-i386-image',
    familyId: 'debian',
    architecture: 'i386',
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
    imageRef: 'ubuntu-18-i386',
    requirements: [
      'Modern browser with WebAssembly (v86)',
      'Ubuntu 18.04 LTS i386 rootfs built locally',
      '512 MiB guest memory',
      'HTTP Range transport of the ext4 image',
    ],
    integrationNote:
      'Ubuntu 18.04.6 LTS (bionic) i386 rootfs built locally by ' +
      'images/ubuntu-18-i386/build.sh with debootstrap against the bionic archive; ' +
      'booted by v86 as bzimage + initrd + hda. Guest writes stay in memory for ' +
      'the duration of the session. No image is distributed. Real boot proven by ' +
      'the E2E suite (tests/e2e/session-ubuntu.spec.ts).',
  },
  {
    id: 'ubuntu-18-i386-desktop-image',
    familyId: 'ubuntu',
    architecture: 'i386',
    imageRef: 'ubuntu-18-i386-desktop',
    requirements: [
      'Modern browser with WebAssembly (v86)',
      'Ubuntu 18.04 LTS i386 rootfs built locally',
      'HTTP Range transport of the ext4 image',
      'Enough memory (≥ 1 GiB)',
      'Xorg framebuffer (/dev/fb0)',
    ],
    integrationNote:
      'Graphical variant of Ubuntu 18.04 LTS (bionic) i386: 3 GiB ext4 rootfs ' +
      'built locally by images/ubuntu-18-i386/build.sh with debootstrap against ' +
      'the bionic archive, plus a kernel and an initrd. Booted by v86 as bzimage + ' +
      'initrd + hda; guest writes stay in memory for the duration of the session. ' +
      'No image is distributed. Real Xorg + Openbox boot proven by the E2E suite ' +
      '(tests/e2e/desktop-ubuntu.spec.ts).',
  },
  {
    id: 'ubuntu-18-i386-xfce-image',
    familyId: 'ubuntu',
    architecture: 'i386',
    imageRef: 'ubuntu-18-i386-xfce',
    requirements: [
      'Modern browser with WebAssembly (v86)',
      'Ubuntu 18.04 LTS i386 rootfs built locally',
      'HTTP Range transport of the ext4 image',
      'Enough memory (≥ 1 GiB)',
      'Xorg framebuffer (/dev/fb0)',
      'XFCE disk (~4 GiB)',
    ],
    integrationNote:
      'Ubuntu 18.04 LTS (bionic) i386 variant with the full XFCE desktop: 4 GiB ' +
      'ext4 rootfs built locally by images/ubuntu-18-i386/build.sh with debootstrap ' +
      'against the bionic archive, plus a kernel and an initrd. Booted by v86 as bzimage ' +
      '+ initrd + hda; guest writes stay in memory for the duration of the session. ' +
      'No image is distributed. Real Xorg + XFCE boot proven by the E2E suite ' +
      '(tests/e2e/xfce-ubuntu.spec.ts).',
  },
  {
    id: 'fedora-44-x86-64-image',
    familyId: 'fedora',
    architecture: 'x86_64',
    imageRef: 'fedora-44-x86-64',
    requirements: [
      'Modern browser with WebAssembly',
      '1024 MiB guest memory',
      'Cross-origin isolation for parallel host threads',
      'Fedora 44 x86-64 live ISO built locally',
    ],
    integrationNote:
      'Fedora 44 x86-64 live ISO built locally by images/fedora-44-x86-64/build.sh ' +
      '(dnf --installroot): a live squashfs whose ISO carries its own GRUB El-Torito ' +
      'boot record, so the disc loads kernel and initramfs itself and v64 only mounts ' +
      'it as a CD-ROM; lumiboot autologin on tty1 and ttyS0. Guest writes stay in ' +
      'memory for the duration of the session. No image is distributed. Real boot ' +
      'proven by the E2E suite (tests/e2e/session-fedora.spec.ts).',
  },
  {
    id: 'windows-7-x86-image',
    familyId: 'windows',
    architecture: 'i386',
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
    id: 'windows-8-1-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    mediaStrategy: 'user-import',
    requiresUserMedia: true,
    requirements: [
      'An already installed Windows 8.1 x64 RAW/IMG disk you legally own',
      'Modern Chromium-class browser with WebAssembly and OPFS',
      'At least 2048 MiB guest memory',
      'Cross-origin isolation for parallel CPU Workers',
      'WebGPU recommended for VMware SVGA 3D acceleration',
    ],
    integrationNote:
      'v64 upstream verifies Windows 8.1 x64 from an installed image on 1, 2 and 4 cores. LumiBoot does not distribute Windows and does not claim that installation from an ISO works. Imported RAW disks are copied once into OPFS and written back there by the CPU Worker.',
  },
  {
    id: 'windows-7-pro-sp1-x86-image',
    familyId: 'windows',
    architecture: 'i386',
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
    imageRef: 'windows-10-x86',
    requirements: [
      'Modern browser with WebAssembly (v86, 32-bit)',
      'Local RAW disk served over HTTP Range (images/windows-10-x86/disk.img)',
      '2048 MiB guest memory',
      'Disk boot (MBR); no Linux kernel',
    ],
    integrationNote:
      'Reuses the Windows 7 local RAW disk + 32-bit v86 pipeline (IDE hda, ' +
      'HTTP Range, guest writes kept in memory for the duration of the session). ' +
      'No ISO is distributed. Validated system, booted by BIOS like Windows 7.',
  },
  {
    id: 'windows-11-x64-image',
    familyId: 'windows',
    architecture: 'x86_64',
    requirements: ['x86-64 browser engine (not integrated yet)', 'Windows license'],
    integrationNote:
      'Not developed yet: no x86-64 browser engine is integrated and no image is ' +
      'bundled or imported. Listed for information only, like macOS.',
  },
  {
    id: 'macos-sequoia-image',
    familyId: 'macos',
    architecture: 'arm64',
    requirements: ['WebAssembly', 'Enough memory', 'macOS license compliance'],
    integrationNote: 'Base image to pair with an ARM browser engine.',
  },
  {
    id: 'custom-image-i386',
    familyId: 'custom',
    architecture: 'i386',
    mediaStrategy: 'user-import',
    requiresUserMedia: true,
    requirements: [
      'A disk media you own (.iso, .img, .raw)',
      'Modern browser with WebAssembly (v86, 32-bit)',
      'Enough memory (≥ 512 MiB)',
    ],
    integrationNote:
      'Generic entry point: start a local disk media (.iso, .img, .raw) you own through ' +
      'v86. The file stays in your browser tab as a local blob and is never uploaded.',
  },
] as const satisfies readonly SystemImageDefinition[];
