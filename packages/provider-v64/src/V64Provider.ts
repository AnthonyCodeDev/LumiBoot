import { DEFAULT_GUEST_READINESS, type OSDefinition, type VMMedia } from '@lumiboot/contracts';
import { DomConsoleAdapter, V86Instance, toV86NetworkDevice } from '@lumiboot/provider-v86';
import {
  ensureImageManifest,
  ensureLocalDiskManifest,
  versionedMediaUrl,
  type ImageManifest,
  type LocalDiskManifest,
} from '@lumiboot/vm-assets';
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
  type V64UsbDevice,
} from './runtime';
import { attachUsbKeyboard } from './usb-keyboard-adapter';

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
  ovmfCode: '/v64/ovmf-code.fd',
  ovmfVars: '/v64/ovmf-vars.fd',
  bochsVga: '/v64/v86-bochs-vga.js',
  virtioGpu: '/v64/v86-virtio-gpu.js',
  vmwareSvga: '/v64/v86-vmware-svga.js',
  hdAudio: '/v64/v86-hd-audio.js',
  ne2k: '/v64/v86-ne2k.js',
  e1000: '/v64/v86-e1000.js',
  usb: '/v64/v86-usb.js',
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
  /** `disk-boot` profiles load a whole-disk manifest instead of an image manifest. */
  readonly resolveLocalDiskManifest?: (
    ref: string,
    signal?: AbortSignal,
  ) => Promise<LocalDiskManifest>;
}

/** x86-64 JIT emulator running entirely in the visitor's browser. */
export class V64Provider implements VMEngine {
  readonly id = V64_PROVIDER_ID;
  readonly #createEngine: (options: V64Options) => V64Runtime | Promise<V64Runtime>;
  readonly #resolveManifest: (ref: string, signal?: AbortSignal) => Promise<ImageManifest>;
  readonly #resolveLocalDiskManifest: (
    ref: string,
    signal?: AbortSignal,
  ) => Promise<LocalDiskManifest>;

  constructor(options: V64ProviderOptions = {}) {
    this.#createEngine = options.createEngine ?? createV64;
    this.#resolveManifest = options.resolveManifest ?? ensureImageManifest;
    this.#resolveLocalDiskManifest =
      options.resolveLocalDiskManifest ?? ((ref, signal) => ensureLocalDiskManifest(ref, signal));
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

    // A `disk-boot` profile boots an installed system from its disk: there is no
    // kernel or ISO to inject, only a whole-disk manifest to mount as `hda` —
    // or, when it declares an ESP, as `hda` (ESP) + `hdb` (system disk).
    const isDiskBoot = profile.readiness?.mode === 'disk-boot';

    const media = configuration?.media;
    if (os.mediaStrategy === 'user-import' && !media) {
      throw new VMError(
        'MEDIA_REQUIRED',
        `"${os.displayName}" requires media supplied by the user.`,
        { systemId: os.id },
      );
    }
    let manifest: ImageManifest | null = null;
    let diskManifest: LocalDiskManifest | null = null;
    if (!media) {
      if (!os.imageRef)
        throw new VMError('IMAGE_MISSING', `No image is associated with "${os.id}".`, {
          systemId: os.id,
        });
      if (isDiskBoot) diskManifest = await this.#resolveLocalDiskManifest(os.imageRef, signal);
      else manifest = await this.#resolveManifest(os.imageRef, signal);
    }

    const memoryMiB =
      configuration?.memoryMiB ??
      profile.configuration?.memoryMiB ??
      manifest?.memoryMiB ??
      diskManifest?.memoryMiB ??
      1024;
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
    // The emulated Apple SMC (macOS `DSMOS`) only exists on q35: a profile that
    // asks for it in writing against i440FX is refused here, before the engine
    // starts, rather than left to the engine's own `create_platform` check.
    const smc = extraOption(configuration, profileConfiguration, 'v64Smc') === true;
    if (smc)
      assertSmcCompatible(os.id, configuration, profileConfiguration, profile.hardwareProfile);
    const machineType = smc ? ('q35' as const) : readMachine(configuration, profileConfiguration);
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
      'hda' | 'hdb' | 'cdrom' | 'bzimage' | 'initrd' | 'cmdline' | 'boot_order'
    >;
    try {
      bootMedia = await resolveBootMedia(os.id, media, manifest, diskManifest, signal);
    } catch (error) {
      consoleAdapter.detach();
      await network.dispose().catch(() => undefined);
      throw new VMError(
        'START_FAILED',
        `The v64 boot media could not be prepared for "${os.id}".`,
        { systemId: os.id, cause: error },
      );
    }

    // UEFI replaces SeaBIOS entirely: `bios`/`vga_bios` must not be sent, and
    // OVMF needs the disk's own NVRAM when it carries a boot entry.
    const uefi = extraOption(configuration, profileConfiguration, 'v64Firmware') === 'uefi';
    const cpuFeatures = readCpuFeatures(configuration, profileConfiguration);
    const qemuCompatible =
      extraOption(configuration, profileConfiguration, 'v64QemuCompatible') === true;
    // Windows' HAL fails in `HalpInitializeClock` on q35/ACPI when the HPET is
    // absent: only profiles that ask for it get the device, so the Alpine and
    // Fedora guests keep their existing layout.
    const hpet = extraOption(configuration, profileConfiguration, 'v64Hpet') === true;
    // USB input is opt-in as well: a profile that does not ask for it keeps the
    // exact engine configuration it had (no controller, no plugin).
    const usb = readUsb(configuration, profileConfiguration);
    const firmwareOptions: Pick<
      V64Options,
      'bios' | 'vga_bios' | 'firmware' | 'qemu_compatible' | 'cpu_features'
    > = uefi
      ? {
          firmware: {
            type: 'uefi',
            code: { url: V64_ASSET_PATHS.ovmfCode },
            vars: { url: diskManifest?.firmware?.vars.url ?? V64_ASSET_PATHS.ovmfVars },
          },
          ...(machineType === 'i440fx' || qemuCompatible ? { qemu_compatible: true } : {}),
          ...(cpuFeatures === undefined ? {} : { cpu_features: cpuFeatures }),
        }
      : {
          bios: { url: V64_ASSET_PATHS.bios },
          vga_bios: { url: V64_ASSET_PATHS.vgaBios },
        };

    const vgaMemoryMiB =
      configuration?.vgaMemoryMiB ??
      profile.configuration?.vgaMemoryMiB ??
      manifest?.vgaMemoryMiB ??
      diskManifest?.vgaMemoryMiB ??
      32;

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
      machine_type: machineType,
      graphics_adapter: graphics,
      graphics_adapter_path: graphicsPath(graphics),
      memory_size: primaryMemoryMiB * MiB,
      ...(extendedMemoryMiB > 0 ? { extended_memory_size: extendedMemoryMiB * MiB } : {}),
      vram_size: vgaMemoryMiB * MiB,
      ...firmwareOptions,
      screen: { container: mounted.screenContainer },
      serial_console: { type: 'textarea', container: mounted.serialTextarea },
      acpi: true,
      ...(hpet ? { hpet: true } : {}),
      audio_device: profile.hardwareProfile?.audio ? 'hd_audio' : 'none',
      ...(profile.hardwareProfile?.audio ? { audio_device_path: V64_ASSET_PATHS.hdAudio } : {}),
      // The SMC owns 0x300-0x31F, so an SMC profile is always offline: the
      // macOS guest has no network device at all, whatever the profile says.
      ...(smc ? { net_device: { type: 'none' as const }, smc: true } : {}),
      ...(smc ? {} : netDevice ? { net_device: netDevice } : {}),
      ...(usb ? { usb } : {}),
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
      // The guest's USB HID keyboard takes the page's keys; libv86's own PS/2
      // path is left as it is. The adapter detaches itself when the emulator
      // stops, so a disposed session leaves no `window` listener behind.
      if (usb?.keyboard === true) attachUsbKeyboard(emulator);
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
  diskManifest: LocalDiskManifest | null,
  signal: AbortSignal | undefined,
): Promise<
  Pick<V64Options, 'hda' | 'hdb' | 'cdrom' | 'bzimage' | 'initrd' | 'cmdline' | 'boot_order'>
> {
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
  if (diskManifest !== null) {
    // Installed system: the whole disk is the boot device, read lazily over Range.
    const disk = { url: diskManifest.boot.url, size: diskManifest.disk.size, async: true };
    if (diskManifest.esp === undefined) return { hda: disk };
    // Two-media layout: OVMF's persisted `Boot0001` entry targets SATA port 0,
    // so the ESP takes `hda` and the installed system moves to `hdb`. The order
    // is not negotiable: swapping the two makes the firmware read the wrong
    // volume and the guest falls back to "no bootable device".
    return {
      hda: { url: diskManifest.esp.url, size: diskManifest.esp.size, async: true },
      hdb: disk,
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
  if (disk && !bzimage && !initrd) {
    // Disk-only image manifest: the firmware boots the disk, like a local disk.
    return { hda: { url: versionedMediaUrl(disk.url, disk.sha256), size: disk.size, async: true } };
  }
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

/**
 * `v64Smc`: the emulated Apple SMC (`APP0001`, `0x300-0x31F`, IRQ 6). libv86
 * refuses two combinations at engine start, so the provider stops them with a
 * readable message first: i440FX keeps the floppy controller's IRQ 6, and the
 * NE2000 puts its data port on the SMC's own `0x300`.
 */
function assertSmcCompatible(
  systemId: string,
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
  hardware:
    { readonly network?: string | undefined; readonly machine?: string | undefined } | undefined,
): void {
  const machine = extraOption(configuration, profileConfiguration, 'v64Machine');
  if (machine === 'i440fx' || hardware?.machine === 'i440fx') {
    throw new VMError(
      'START_FAILED',
      `The emulated Apple SMC (v64Smc) needs machine_type "q35": on i440FX the floppy controller keeps IRQ 6, which AppleSMC.kext needs. Drop v64Machine: "i440fx" (or machine "i440fx") from "${systemId}", or drop v64Smc.`,
      { systemId },
    );
  }
  if (hardware?.network === 'ne2k') {
    throw new VMError(
      'START_FAILED',
      `The emulated Apple SMC (v64Smc) and the NE2000 both use the I/O ports 0x300-0x31F: the NE2000's data port is 0x300, the Apple SMC's too. An SMC profile is offline, so declare hardwareProfile.network "none" (or "e1000", which is on MMIO) or drop the explicit "ne2k".`,
      { systemId },
    );
  }
}

/** Named baseline (`x86-64-v2`/`v3`) or an explicit feature list. */
function readCpuFeatures(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
): V64Options['cpu_features'] {
  const value = extraOption(configuration, profileConfiguration, 'v64CpuFeatures');
  if (value === 'x86-64-v2' || value === 'x86-64-v3') return value;
  if (Array.isArray(value)) {
    const features = value as readonly unknown[];
    if (features.length > 0 && features.every((feature) => typeof feature === 'string')) {
      return features as ReadonlyArray<string>;
    }
  }
  return undefined;
}

/**
 * `v64UsbTablet` / `v64UsbKeyboard` / `v64UsbController`: the USB host
 * controller and its HID devices. The catalogue's `extra` bag only carries
 * scalars, so each device is its own flag, like `v64Hpet`. Absent (or asking
 * for neither device) keeps the engine config free of `usb`, exactly as before
 * this option existed.
 */
function readUsb(
  configuration: VMConfiguration | undefined,
  profileConfiguration: ExtraConfiguration | undefined,
): V64UsbDevice | undefined {
  const tablet = extraOption(configuration, profileConfiguration, 'v64UsbTablet') === true;
  const keyboard = extraOption(configuration, profileConfiguration, 'v64UsbKeyboard') === true;
  if (!tablet && !keyboard) return undefined;
  const controller = extraOption(configuration, profileConfiguration, 'v64UsbController');
  return {
    // UHCI is what the Lion campaign's harness proved: two ports, tablet then keyboard.
    controller: controller === 'ehci' || controller === 'xhci' ? controller : 'uhci',
    tablet,
    keyboard,
    plugin_path: V64_ASSET_PATHS.usb,
  };
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
