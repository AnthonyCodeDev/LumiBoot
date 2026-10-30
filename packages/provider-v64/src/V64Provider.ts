import { DEFAULT_GUEST_READINESS, type OSDefinition, type VMMedia } from '@lumiboot/contracts';
import { DomConsoleAdapter, V86Instance, toV86NetworkDevice } from '@lumiboot/provider-v86';
import { ensureImageManifest, versionedMediaUrl, type ImageManifest } from '@lumiboot/vm-assets';
import {
  VMError,
  type VMCapabilities,
  type VMConfiguration,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import { createNetworkController, defaultNetworkProfile } from '@lumiboot/vm-network';
import { ensurePersistentV64Disk } from './opfs';
import {
  createV64,
  loadV64WebGpu,
  type V64NetworkDevice,
  type V64Options,
  type V64Runtime,
} from './runtime';

export const V64_PROVIDER_ID = 'v64';
const MiB = 1024 * 1024;
/** libv86 caps primary RAM below 2 GiB; anything above goes to extended memory. */
const MAX_PRIMARY_MEMORY_MIB = 2047;
const BOOT_ORDER_CD_HARDDISK_FLOPPY = 0x123;

export const V64_ASSET_PATHS = {
  wasm: '/v64/v86.wasm',
  wasmFallback: '/v64/v86-fallback.wasm',
  parallelWasm: '/v64/v86-parallel.wasm',
  cpuWorker: '/v64/cpu-worker.js',
  vcpuWorker: '/v64/vcpu-worker.js',
  bios: '/v64/seabios.bin',
  vgaBios: '/v64/vgabios.bin',
  bochsVga: '/v64/v86-bochs-vga.js',
  virtioGpu: '/v64/v86-virtio-gpu.js',
  vmwareSvga: '/v64/v86-vmware-svga.js',
  hdAudio: '/v64/v86-hd-audio.js',
  ne2k: '/v64/v86-ne2k.js',
  e1000: '/v64/v86-e1000.js',
} as const;

const V64_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['x86_64'],
  ramSnapshots: false,
  diskSnapshots: false,
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

export interface V64ProviderOptions {
  readonly createEngine?: (options: V64Options) => V64Runtime | Promise<V64Runtime>;
  readonly resolveManifest?: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
}

/** x86-64 JIT emulator running entirely in the visitor's browser. */
export class V64Provider implements VMEngine {
  readonly id = V64_PROVIDER_ID;
  readonly #createEngine: (options: V64Options) => V64Runtime | Promise<V64Runtime>;
  readonly #resolveManifest: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;

  constructor(options: V64ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? createV64;
    this.#resolveManifest = options.resolveManifest ?? ensureImageManifest;
  }

  capabilities(): VMCapabilities {
    return V64_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return (
      os.architecture === 'x86_64' &&
      os.launchProfiles.some(
        (profile) => profile.engineId === V64_PROVIDER_ID && profile.executionMode === 'browser',
      )
    );
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    if (typeof HTMLElement === 'undefined' || !(mountTarget instanceof HTMLElement)) {
      throw new VMError('START_FAILED', 'Invalid mount target for the v64 console.', {
        systemId: os.id,
      });
    }
    const profile = os.launchProfiles.find(
      (candidate) =>
        candidate.engineId === V64_PROVIDER_ID && candidate.executionMode === 'browser',
    );
    if (!profile || os.architecture !== 'x86_64') {
      throw new VMError('ENGINE_NOT_INTEGRATED', `Engine "v64" is not integrated for "${os.id}".`, {
        systemId: os.id,
      });
    }
    const signal = configuration?.signal;
    if (signal?.aborted)
      throw new VMError('START_FAILED', `Start canceled for "${os.id}".`, { systemId: os.id });

    const media = configuration?.media;
    if (os.mediaStrategy === 'user-import' && !media) {
      throw new VMError(
        'MEDIA_REQUIRED',
        `"${os.displayName}" requires media supplied by the user.`,
        { systemId: os.id },
      );
    }
    let manifest: ImageManifest | null = null;
    if (!media) {
      if (!os.imageRef)
        throw new VMError('IMAGE_MISSING', `No image is associated with "${os.id}".`, {
          systemId: os.id,
        });
      manifest = await this.#resolveManifest(os.imageRef, signal);
    }

    const memoryMiB =
      configuration?.memoryMiB ?? profile.configuration?.memoryMiB ?? manifest?.memoryMiB ?? 1024;
    if (!Number.isInteger(memoryMiB) || memoryMiB < 128 || memoryMiB > 65_408) {
      throw new VMError(
        'START_FAILED',
        `v64 memory must be an integer from 128 to 65408 MiB (received ${memoryMiB}).`,
        { systemId: os.id },
      );
    }
    let primaryMemoryMiB = Math.min(memoryMiB, MAX_PRIMARY_MEMORY_MIB);
    let extendedMemoryMiB = 0;
    if (memoryMiB > primaryMemoryMiB) {
      // libv86 rejects an extended size that is not a non-zero multiple of 2 MiB.
      extendedMemoryMiB = Math.ceil((memoryMiB - primaryMemoryMiB) / 2) * 2;
      primaryMemoryMiB = memoryMiB - extendedMemoryMiB;
    }
    // `extra` is a profile decision: the application only passes the network,
    // the media and the abort signal, so the profile stays the fallback.
    const profileConfiguration = profile.configuration;
    const cores = readInteger(configuration, profileConfiguration, 'v64CpuCores', 2, 1, 8);
    const graphics = readGraphics(configuration, profileConfiguration);
    const wantsWebGpu =
      graphics !== 'bochs_vga' && typeof navigator !== 'undefined' && 'gpu' in navigator;
    if (wantsWebGpu) await loadV64WebGpu().catch(() => undefined);

    const networkProfile = configuration?.network ?? defaultNetworkProfile;
    const network = createNetworkController({ profile: networkProfile });
    const netDevice = resolveNetworkDevice(networkProfile, profile.hardwareProfile?.network);
    await network.start(signal);

    const consoleAdapter = new DomConsoleAdapter();
    const mounted = consoleAdapter.attach(mountTarget);
    let bootMedia: Pick<
      V64Options,
      'hda' | 'cdrom' | 'bzimage' | 'initrd' | 'cmdline' | 'boot_order'
    >;
    try {
      bootMedia = await resolveBootMedia(os.id, media, manifest, signal);
    } catch (error) {
      consoleAdapter.detach();
      await network.dispose().catch(() => undefined);
      throw new VMError(
        'START_FAILED',
        `The v64 boot media could not be prepared for "${os.id}".`,
        { systemId: os.id, cause: error },
      );
    }

    const options: V64Options = {
      wasm_path: V64_ASSET_PATHS.wasm,
      wasm_fallback_path: V64_ASSET_PATHS.wasmFallback,
      cpu_worker: true,
      cpu_worker_url: V64_ASSET_PATHS.cpuWorker,
      parallel: 'auto',
      parallel_wasm_path: V64_ASSET_PATHS.parallelWasm,
      vcpu_worker_url: V64_ASSET_PATHS.vcpuWorker,
      cpu_type: 'x86_64',
      cpu_cores: cores,
      experimental_smp_jit: cores > 1,
      machine_type: readMachine(configuration, profileConfiguration),
      graphics_adapter: graphics,
      graphics_adapter_path: graphicsPath(graphics),
      memory_size: primaryMemoryMiB * MiB,
      ...(extendedMemoryMiB > 0 ? { extended_memory_size: extendedMemoryMiB * MiB } : {}),
      vram_size: (configuration?.vgaMemoryMiB ?? profile.configuration?.vgaMemoryMiB ?? 32) * MiB,
      bios: { url: V64_ASSET_PATHS.bios },
      vga_bios: { url: V64_ASSET_PATHS.vgaBios },
      screen: { container: mounted.screenContainer },
      serial_console: { type: 'textarea', container: mounted.serialTextarea },
      acpi: true,
      audio_device: profile.hardwareProfile?.audio ? 'hd_audio' : 'none',
      ...(profile.hardwareProfile?.audio ? { audio_device_path: V64_ASSET_PATHS.hdAudio } : {}),
      ...(netDevice ? { net_device: netDevice } : {}),
      ...bootMedia,
      autostart: false,
    };
    let emulator: V64Runtime;
    try {
      emulator = await this.#createEngine(options);
    } catch (error) {
      consoleAdapter.detach();
      await network.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `The v64 engine could not initialize for "${os.id}".`, {
        systemId: os.id,
        cause: error,
      });
    }
    let instance: V86Instance;
    try {
      instance = new V86Instance({
        providerId: this.id,
        systemId: os.id,
        emulator: emulator as never,
        console: consoleAdapter,
        readiness: profile.readiness ?? DEFAULT_GUEST_READINESS,
        network,
      });
      instance.wire();
    } catch (error) {
      // A wiring failure must leave no orphaned emulator, network or console.
      try {
        await emulator.destroy();
      } catch {
        /* best-effort cleanup */
      }
      consoleAdapter.detach();
      await network.dispose().catch(() => undefined);
      throw new VMError('START_FAILED', `The v64 session could not be wired for "${os.id}".`, {
        systemId: os.id,
        cause: error,
      });
    }
    return instance;
  }
}

async function resolveBootMedia(
  systemId: string,
  media: VMMedia | undefined,
  manifest: ImageManifest | null,
  signal: AbortSignal | undefined,
): Promise<Pick<V64Options, 'hda' | 'cdrom' | 'bzimage' | 'initrd' | 'cmdline' | 'boot_order'>> {
  if (media?.format === 'raw') {
    const disk = await ensurePersistentV64Disk(systemId, media, signal);
    return { hda: { url: disk.url, size: disk.size, disk_option: 'read_write' } };
  }
  if (media?.format === 'iso') {
    return {
      cdrom: { url: media.url, size: media.size, async: true },
      boot_order: BOOT_ORDER_CD_HARDDISK_FLOPPY,
    };
  }
  const disk = manifest?.files.disk;
  if (manifest?.boot?.cdromOnly === true) {
    if (!disk) throw new Error('A cdromOnly manifest needs a disk file (the bootable ISO).');
    return {
      // The ISO boots itself through GRUB on El-Torito: no bzimage/initrd is
      // injected, so the initrd window hard-coded at 64 MiB in libv86.mjs can no
      // longer be overwritten by a kernel that decompresses above it (the reason
      // the Fedora live image panicked with "junk within compressed archive").
      // Synchronous ISO buffer, like the injected-bzimage path: the ranged ATAPI
      // path races IDE DMA (HSM violation, "BMDMA stat 0x5" in the guest log),
      // and the stalled CD reads then starve udev until a device wait expires.
      cdrom: { url: versionedMediaUrl(disk.url, disk.sha256), size: disk.size },
      boot_order: BOOT_ORDER_CD_HARDDISK_FLOPPY,
    };
  }
  const bzimage = manifest?.files.bzimage;
  const initrd = manifest?.files.initrd;
  if (!disk || !bzimage || !initrd)
    throw new Error('The manifest needs disk, bzimage and initrd files.');
  return {
    // Synchronous ISO buffer: the ranged ATAPI path races IDE DMA (HSM violation).
    cdrom: { url: versionedMediaUrl(disk.url, disk.sha256), size: disk.size },
    bzimage: { url: versionedMediaUrl(bzimage.url, bzimage.sha256), size: bzimage.size },
    initrd: { url: versionedMediaUrl(initrd.url, initrd.sha256), size: initrd.size },
    cmdline:
      manifest?.boot?.cmdline ?? 'console=ttyS0,115200 modules=loop,squashfs,sd-mod,usb-storage',
    boot_order: BOOT_ORDER_CD_HARDDISK_FLOPPY,
  };
}

/** Only the `extra` bag is read from a profile: its literal type is not a `VMConfiguration`. */
interface ExtraConfiguration {
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** Reads an `extra` option: the caller's configuration wins over the profile. */
function extraOption(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
  key: string,
): unknown {
  return configuration?.extra?.[key] ?? profileConfiguration?.extra?.[key];
}

function readInteger(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = extraOption(configuration, profileConfiguration, key);
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function readGraphics(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
): V64Options['graphics_adapter'] {
  const value = extraOption(configuration, profileConfiguration, 'v64Graphics');
  return value === 'virtio_gpu' || value === 'vmware_svga' ? value : 'bochs_vga';
}

function readMachine(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
): V64Options['machine_type'] {
  return extraOption(configuration, profileConfiguration, 'v64Machine') === 'q35'
    ? 'q35'
    : 'i440fx';
}

function graphicsPath(graphics: V64Options['graphics_adapter']): string {
  if (graphics === 'virtio_gpu') return V64_ASSET_PATHS.virtioGpu;
  if (graphics === 'vmware_svga') return V64_ASSET_PATHS.vmwareSvga;
  return V64_ASSET_PATHS.bochsVga;
}

function resolveNetworkDevice(
  profile: Parameters<typeof toV86NetworkDevice>[0],
  hardware: string | undefined,
): V64NetworkDevice | undefined {
  const transport = toV86NetworkDevice(profile);
  if (!transport || hardware === 'none') return undefined;
  const type = hardware === 'ne2k' || hardware === 'e1000' ? hardware : 'virtio';
  const pluginPath =
    type === 'ne2k' ? V64_ASSET_PATHS.ne2k : type === 'e1000' ? V64_ASSET_PATHS.e1000 : undefined;
  return {
    type,
    ...(typeof transport.relay_url === 'string' ? { relay_url: transport.relay_url } : {}),
    ...(pluginPath ? { plugin_path: pluginPath } : {}),
  };
}
