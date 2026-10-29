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
  versionedMediaUrl,
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
import { installRangeFetchTransport } from './range-fetch-transport';
import { V86Instance } from './v86-instance';

export const V86_PROVIDER_ID = 'v86';

const MiB = 1024 * 1024;

export const V86_ASSET_PATHS = {
  wasm: '/v86/v86.wasm',
  bios: '/v86/seabios.bin',
  vgaBios: '/v86/vgabios.bin',
} as const;

/** 115200 serial console; rootwait/rootdelay=5 wait for the async range disk. */
export const DEFAULT_BOOT_CMDLINE =
  'console=tty0 console=ttyS0,115200 root=/dev/sda rw rootwait rootdelay=5';

/** Numeric duplicate: the provider must not import `v86` at load time. */
const BOOT_ORDER_CD_HARDDISK_FLOPPY = 0x123 as BootOrder;

/** `VMInstance` has no snapshot entry point, so snapshots are not advertised. */
const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
  // v86 reads the disk through HTTP Range requests.
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

export interface V86ProviderOptions {
  /** Injectable in tests; real engine by default. */
  createEngine?: V86Factory;
  /** Defaults to `ensureImageManifest`. */
  resolveManifest?: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  resolveDiskManifest?: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
  /** Injectable in tests; DOM console by default. */
  createConsole?: () => V86ConsoleAdapter;
  /** Installs the Range-aware XHR before v86 loads; injectable for tests. */
  installRangeTransport?: () => () => void;
}

/** 32-bit x86 browser engine backed by v86. */
export class V86Provider implements VMEngine {
  readonly id = V86_PROVIDER_ID;
  readonly #createEngine: V86Factory;
  readonly #resolveManifest: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  readonly #resolveDiskManifest: (ref: string, signal?: AbortSignal) => Promise<LocalDiskManifest>;
  readonly #createConsole: () => V86ConsoleAdapter;
  readonly #installRangeTransport: () => () => void;

  constructor(options: V86ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? ((config) => createBrowserV86(config));
    this.#resolveManifest =
      options.resolveManifest ?? ((ref, signal) => ensureImageManifest(ref, signal));
    this.#resolveDiskManifest =
      options.resolveDiskManifest ?? ((ref, signal) => ensureLocalDiskManifest(ref, signal));
    this.#createConsole = options.createConsole ?? (() => new DomConsoleAdapter());
    this.#installRangeTransport =
      options.installRangeTransport ?? (() => installRangeFetchTransport());
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

    // A `disk-boot` profile boots a hard disk through BIOS, without a kernel.
    const isDiskBoot = launchProfile.readiness?.mode === 'disk-boot';

    // Imported media boots through BIOS; no proprietary media is shipped.
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

    // Network must be fixed before the emulator is built: changing it restarts v86.
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
      // The network controller must not survive a failed mount.
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
    // RAW disks stay read-only via ranges: guest writes live in memory, lost on stop.
    const bootMedia: V86Options = media
      ? resolveMediaBootOptions(media, launchProfile, configuration, os.id)
      : diskManifest
        ? {
            hda: {
              url: versionedMediaUrl(diskManifest.boot.url, diskManifest.disk.sha256),
              async: true,
              size: diskManifest.disk.size,
            },
          }
        : {
            bzimage: { url: versionedMediaUrl(bzimage!.url, bzimage!.sha256) },
            initrd: { url: versionedMediaUrl(initrd!.url, initrd!.sha256) },
            cmdline: bootOptions.cmdline ?? DEFAULT_BOOT_CMDLINE,
            hda: {
              url: versionedMediaUrl(kernelDisk!.url, kernelDisk!.sha256),
              async: true,
              size: kernelDisk!.size,
            },
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
      // NT guests require ACPI; imported media and local disks enable it.
      ...(media === undefined && diskManifest === null
        ? {}
        : { acpi: launchProfile.hardwareProfile?.acpi ?? false }),
      ...(netDevice === undefined ? {} : { net_device: netDevice }),
    };

    let emulator: Awaited<ReturnType<V86Factory>>;
    try {
      // Before v86's dynamic import: its reads are XHR+Range, the ctor is the only hook.
      // Kept for the page: a restart must not leave a window hitting the cache.
      this.#installRangeTransport();
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
      // Wiring failure must leave no orphaned resource.
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

/** v86 clamps to 2^31-128 KiB: reject > 2048 MiB instead of reducing silently. */
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

/** Network failures fail the session at start, never silently. */
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

/** raw media: read-only hda. iso: CD-ROM. Installation ISOs are rejected. */
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
