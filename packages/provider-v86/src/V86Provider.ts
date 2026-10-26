import { DEFAULT_GUEST_READINESS, type OSDefinition, type VMMedia } from '@lumiboot/contracts';
import {
  VMError,
  isVMError,
  type VMConfiguration,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import {
  createNetworkController,
  defaultNetworkProfile,
  isNetworkError,
} from '@lumiboot/vm-network';
import {
  ensureImageManifest,
  ensureLocalDiskManifest,
  type ImageManifest,
  type LocalDiskManifest,
} from '@lumiboot/vm-assets';
import type { BootOrder, V86Options } from 'v86';
import { createBrowserV86, type V86Factory } from './browser-v86';
import { DomConsoleAdapter, type V86ConsoleAdapter, type V86ConsoleMount } from './console-adapter';
import {
  toV86NetworkDevice,
  toV86NetworkDeviceType,
  type V86NetworkDevice,
} from './network/V86NetworkAdapter';
import { V86Instance } from './v86-instance';

export const V86_PROVIDER_ID = 'v86';

const MiB = 1024 * 1024;

/** Static locations of the engine binaries, prepared outside the repository. */
export const V86_ASSET_PATHS = {
  wasm: '/v86/v86.wasm',
  bios: '/v86/seabios.bin',
  vgaBios: '/v86/vgabios.bin',
} as const;

/**
 * Kernel command line: 115200 serial console for the interactive console,
 * `root=/dev/sda` maps to the `hda` disk passed to v86.
 */
export const DEFAULT_BOOT_CMDLINE = 'console=tty0 console=ttyS0,115200 root=/dev/sda rw';

/**
 * `BootOrder` values (v86) we need, duplicated as numbers so we NEVER import
 * `v86` while loading the provider (the engine stays lazily loaded by
 * `browser-v86`). `CD_HARDDISK_FLOPPY = 0x123` boots the CD-ROM first, then the
 * hard disk.
 */
const BOOT_ORDER_CD_HARDDISK_FLOPPY = 0x123 as BootOrder;

/**
 * ACTUAL capabilities of the engine. `VMInstance` exposes no snapshot entry
 * point (RAM or disk): the provider must therefore never advertise
 * `ramSnapshots`/`diskSnapshots`, even if the `V86` class has an internal
 * `save_state`/`restore_state` not wired to the contract. Advertising a
 * capability missing from `VMInstance` would make the UI promise a feature that
 * does not exist.
 */
const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
  // v86 reads the disk through HTTP Range requests (`hda.async`).
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

export interface V86ProviderOptions {
  /** v86 instance factory (real by default, injectable in tests). */
  createEngine?: V86Factory;
  /** Image manifest resolution (`ensureImageManifest` by default). */
  resolveManifest?: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  /**
   * Manifest resolution of a local disk booted by BIOS
   * (`ensureLocalDiskManifest` by default).
   */
  resolveDiskManifest?: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
  /** Console adapter factory (VGA + serial), injectable in tests. */
  createConsole?: () => V86ConsoleAdapter;
}

/**
 * 32-bit x86 browser engine backed by v86.
 *
 * All v86 knowledge stays confined here: the UI only sees a `VMInstance`. The
 * instance is only created when a session starts, and the guest kernel is never
 * considered operational before the `LUMIBOOT_GUEST_READY` marker is emitted on
 * `ttyS0`.
 */
export class V86Provider implements VMEngine {
  readonly id = V86_PROVIDER_ID;
  readonly #createEngine: V86Factory;
  readonly #resolveManifest: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  readonly #resolveDiskManifest: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
  readonly #createConsole: () => V86ConsoleAdapter;

  constructor(options: V86ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? ((config) => createBrowserV86(config));
    this.#resolveManifest =
      options.resolveManifest ?? ((ref, signal) => ensureImageManifest(ref, signal));
    this.#resolveDiskManifest =
      options.resolveDiskManifest ?? ((ref, signal) => ensureLocalDiskManifest(ref, signal));
    this.#createConsole = options.createConsole ?? (() => new DomConsoleAdapter());
  }

  capabilities(): VMCapabilities {
    return V86_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return os.launchProfiles.some(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    if (typeof HTMLElement === 'undefined' || !(mountTarget instanceof HTMLElement)) {
      throw new VMError('START_FAILED', 'Invalid mount target for the v86 console.', {
        systemId: os.id,
      });
    }

    const launchProfile = os.launchProfiles.find(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
    if (!launchProfile) {
      throw new VMError('ENGINE_NOT_INTEGRATED', `Engine "v86" is not integrated for "${os.id}".`, {
        systemId: os.id,
      });
    }

    const signal = configuration?.signal;
    if (signal?.aborted) {
      throw new VMError('START_FAILED', `Start canceled for "${os.id}".`, {
        systemId: os.id,
      });
    }

    // A `disk-boot` profile boots a hard disk through BIOS (no Linux kernel):
    // either a RAW disk from the codebase (e.g. Windows 7) or a locally imported
    // media. A `guest-marker` profile boots a published image through the kernel.
    const isDiskBoot = launchProfile.readiness?.mode === 'disk-boot';

    // Media imported by the user: direct BIOS boot. LumiBoot distributes NO
    // proprietary media: it must have been provided locally.
    const media = configuration?.media;
    if (os.mediaStrategy === 'user-import' && media === undefined) {
      throw new VMError(
        'MEDIA_REQUIRED',
        `"${os.displayName}" requires a disk media provided by the user. ` +
          'Import an image you legally own to start the session.',
        { systemId: os.id },
      );
    }

    let manifest: ImageManifest | null = null;
    let diskManifest: LocalDiskManifest | null = null;
    if (media === undefined) {
      if (!os.imageRef) {
        throw new VMError('IMAGE_MISSING', `No image is associated with "${os.id}".`, {
          systemId: os.id,
        });
      }
      if (isDiskBoot) {
        // Local RAW disk from the codebase: booted by BIOS via HTTP Range.
        diskManifest = await this.#loadDiskManifest(os, signal);
      } else {
        manifest = await this.#loadManifest(os, signal);
        const disk = manifest.files['disk'];
        const bzimage = manifest.files['bzimage'];
        const initrd = manifest.files['initrd'];
        if (!disk || !bzimage || !initrd) {
          throw new VMError(
            'IMAGE_MISSING',
            `Manifest "${manifest.ref}" does not contain the required disk/bzimage/initrd files.`,
            { systemId: os.id },
          );
        }
      }
    }

    const memoryMiB = resolveMemoryMiB(
      manifest?.memoryMiB ?? diskManifest?.memoryMiB,
      launchProfile.configuration,
      configuration,
    );
    assertSupportedMemoryMiB(memoryMiB, 'memory_size', os.id);
    const vgaMemoryMiB =
      configuration?.vgaMemoryMiB ??
      launchProfile.configuration?.vgaMemoryMiB ??
      manifest?.vgaMemoryMiB ??
      diskManifest?.vgaMemoryMiB ??
      8;

    // Network fixed BEFORE building the emulator: changing the network interface
    // requires a full v86 restart. Each session owns its own controller (never
    // shared between sessions).
    //
    // The emulated card comes from the HARDWARE PROFILE of the catalog: the
    // provider only translates that contract (`network` -> `net_device.type`),
    // never a per-system decision.
    const networkProfile = configuration?.network ?? defaultNetworkProfile;
    const networkController = createNetworkController({ profile: networkProfile });
    let netDevice: V86NetworkDevice | undefined;
    try {
      const transport = toV86NetworkDevice(networkProfile);
      const deviceType = toV86NetworkDeviceType(launchProfile.hardwareProfile);
      if (transport !== undefined && deviceType !== undefined) {
        netDevice = { ...transport, type: deviceType };
      }
      await networkController.start(signal);
    } catch (error) {
      await networkController.dispose().catch(() => undefined);
      throw toStartFailure(error, os.id);
    }

    const consoleAdapter = this.#createConsole();
    let mounted: V86ConsoleMount;
    try {
      mounted = consoleAdapter.attach(mountTarget);
    } catch (error) {
      // Mounting the console can fail (unexpected DOM): the network controller
      // must never survive a start failure.
      await networkController.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `The v86 console could not be mounted for "${os.id}".`, {
        systemId: os.id,
        cause: error,
      });
    }

    const bootOptions = manifest?.boot ?? {};
    const kernelDisk = manifest?.files['disk'];
    const bzimage = manifest?.files['bzimage'];
    const initrd = manifest?.files['initrd'];
    // Real boot plans:
    // - imported RAW media -> BIOS + disk (`hda`), no Linux kernel;
    // - imported ISO media -> BIOS + CD-ROM (`cdrom`) + CD-first boot order;
    // - local RAW disk -> BIOS + disk (`hda`), no Linux kernel;
    // - published image -> direct kernel boot (`bzimage`/`initrd` + `hda`).
    //
    // A RAW disk is read-only through Range requests (`async`): the base is
    // never rewritten, guest writes stay in the memory buffer and disappear on
    // stop (no persistence claimed, see docs/windows-7.md). An ISO is an optical
    // media: it is NEVER mounted as a hard disk.
    const bootMedia: V86Options = media
      ? resolveMediaBootOptions(media, launchProfile, configuration, os.id)
      : diskManifest
        ? {
            hda: {
              url: diskManifest.boot.url,
              async: true,
              size: diskManifest.disk.size,
            },
          }
        : {
            bzimage: { url: bzimage!.url },
            initrd: { url: initrd!.url },
            cmdline: bootOptions.cmdline ?? DEFAULT_BOOT_CMDLINE,
            hda: { url: kernelDisk!.url, async: true, size: kernelDisk!.size },
          };
    const options: V86Options = {
      wasm_path: bootOptions.wasmPath ?? V86_ASSET_PATHS.wasm,
      bios: { url: bootOptions.biosUrl ?? V86_ASSET_PATHS.bios },
      vga_bios: { url: bootOptions.vgaBiosUrl ?? V86_ASSET_PATHS.vgaBios },
      memory_size: memoryMiB * MiB,
      vga_memory_size: vgaMemoryMiB * MiB,
      screen: { container: mounted.screenContainer },
      serial_console: { type: 'textarea', container: mounted.serialTextarea },
      autostart: false,
      ...bootMedia,
      // ACPI comes from the hardware profile (required by modern NT guests).
      // A session with imported media OR a local disk needs it.
      ...(media === undefined && diskManifest === null
        ? {}
        : { acpi: launchProfile.hardwareProfile?.acpi ?? false }),
      ...(netDevice === undefined ? {} : { net_device: netDevice }),
    };

    let emulator: Awaited<ReturnType<V86Factory>>;
    try {
      emulator = await this.#createEngine(options);
    } catch (error) {
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `The v86 engine could not initialize for "${os.id}".`, {
        systemId: os.id,
        cause: error,
      });
    }

    if (signal?.aborted) {
      try {
        await emulator.destroy();
      } catch {
        /* best-effort cleanup */
      }
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `Start canceled for "${os.id}".`, {
        systemId: os.id,
      });
    }

    let instance: V86Instance;
    try {
      instance = new V86Instance({
        providerId: this.id,
        systemId: os.id,
        emulator,
        console: consoleAdapter,
        readiness: launchProfile.readiness ?? DEFAULT_GUEST_READINESS,
        network: networkController,
      });
      instance.wire();
    } catch (error) {
      // Last safety net: if wiring fails, destroy the emulator and release the
      // network controller so no orphaned resource is left behind.
      try {
        await emulator.destroy();
      } catch {
        /* best-effort cleanup */
      }
      consoleAdapter.detach();
      await networkController.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `The v86 session could not be wired for "${os.id}".`, {
        systemId: os.id,
        cause: error,
      });
    }
    return instance;
  }

  async #loadManifest(os: OSDefinition, signal: AbortSignal | undefined): Promise<ImageManifest> {
    const ref = os.imageRef;
    if (!ref) {
      throw new VMError('IMAGE_MISSING', `No image is associated with "${os.id}".`, {
        systemId: os.id,
      });
    }
    try {
      return await this.#resolveManifest(ref, signal);
    } catch (error) {
      if (error instanceof VMError) throw error;
      throw new VMError('IMAGE_MISSING', `Image "${ref}" is unavailable.`, {
        systemId: os.id,
        cause: error,
      });
    }
  }

  async #loadDiskManifest(
    os: OSDefinition,
    signal: AbortSignal | undefined,
  ): Promise<LocalDiskManifest> {
    const ref = os.imageRef;
    if (!ref) {
      throw new VMError('IMAGE_MISSING', `No disk is associated with "${os.id}".`, {
        systemId: os.id,
      });
    }
    try {
      return await this.#resolveDiskManifest(ref, signal);
    } catch (error) {
      if (error instanceof VMError) throw error;
      throw new VMError('IMAGE_MISSING', `Disk "${ref}" is unavailable.`, {
        systemId: os.id,
        cause: error,
      });
    }
  }
}

/** Default memory when no layer provides it. */
const DEFAULT_MEMORY_MIB = 512;

interface MemoryHint {
  readonly memoryMiB?: number | undefined;
}

function resolveMemoryMiB(
  manifestMemoryMiB: number | undefined,
  profileConfiguration: MemoryHint | undefined,
  runtimeConfiguration: MemoryHint | undefined,
): number {
  return (
    runtimeConfiguration?.memoryMiB ??
    profileConfiguration?.memoryMiB ??
    manifestMemoryMiB ??
    DEFAULT_MEMORY_MIB
  );
}

/**
 * Validates guest memory against the ACTUAL constraints of v86 0.5.471.
 *
 * `create_memory` receives the size in bytes and rounds it down to a multiple of
 * 128 KiB. Above 2 GiB (`0x80000000`), the 32-bit integer overflows and becomes
 * negative; v86 does NOT trust that value and clamps it to `2^31 - 128 KiB`
 * (≈ 2047.875 MiB). The useful upper bound is therefore 2048 MiB (2 GiB), which
 * v86 accepts and reduces itself internally. A strictly greater value (e.g.
 * 4096) would be silently reduced to ~2 GiB: we reject it here rather than
 * promise memory that is not honored. A power of two is NOT required: 1536 MiB
 * is valid and accepted.
 */
function assertSupportedMemoryMiB(value: number, label: string, systemId: string): void {
  const supported = Number.isInteger(value) && value > 0 && value * MiB <= 0x80000000;
  if (!supported) {
    throw new VMError(
      'START_FAILED',
      `"${label}" must be an integer number of MiB <= 2048 (received: ${value} MiB).`,
      { systemId },
    );
  }
}

/**
 * Converts any network layer failure into a start `VMError`: an invalid profile
 * (`user-relay` without a `wss://` URL, `local-network`) must fail the session at
 * start, never silently.
 */
function toStartFailure(error: unknown, systemId: string): VMError {
  if (isVMError(error)) return error;
  if (isNetworkError(error)) {
    return new VMError('START_FAILED', error.message, { systemId, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VMError('START_FAILED', `The network could not be initialized: ${message}`, {
    systemId,
    cause: error,
  });
}

/**
 * Translates a media imported by the user into v86 options, depending on its
 * format:
 *
 * - `raw`: hard disk (`hda`), read-only through Range requests (`async`).
 * - `iso`: optical media mounted as CD-ROM (`cdrom`) with a CD-first boot order.
 *
 * Installing an OS onto a blank disk is NOT supported: LumiBoot provides no
 * persistent writable disk and v86 writes to memory (lost on stop). An ISO meant
 * for installation is therefore rejected by an explicit `VMError`
 * (`UNSUPPORTED_ENVIRONMENT`) rather than simulating persistence. Only a "live"
 * bootable ISO (non-`disk-boot` profile and `bootDevice: 'cdrom'`) is accepted.
 */
function resolveMediaBootOptions(
  media: VMMedia,
  launchProfile: OSDefinition['launchProfiles'][number],
  configuration: VMConfiguration | undefined,
  systemId: string,
): V86Options {
  if (media.format === 'raw') {
    return { hda: { url: media.url, async: true, size: media.size } };
  }

  const bootTarget = configuration?.bootDevice ?? launchProfile.configuration?.bootDevice;
  const installsToDisk = launchProfile.readiness?.mode === 'disk-boot' || bootTarget === 'disk';
  if (installsToDisk) {
    throw new VMError(
      'UNSUPPORTED_ENVIRONMENT',
      'Installation onto a blank disk is not supported: LumiBoot mounts no writable ' +
        'disk and persists no write (v86 writes to memory, lost on stop). ' +
        'Provide an already installed RAW disk instead of an installation ISO.',
      { systemId },
    );
  }

  return {
    cdrom: { url: media.url, async: true, size: media.size },
    boot_order: BOOT_ORDER_CD_HARDDISK_FLOPPY,
  };
}
