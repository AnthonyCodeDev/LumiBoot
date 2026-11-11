// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import type { ImageManifest, LocalDiskManifest } from '@lumiboot/vm-assets';
import { V64Provider } from './V64Provider';
import type { V64Options, V64Runtime } from './runtime';

const system: OSDefinition = {
  id: 'alpine-test-x64',
  slug: 'alpine-test-x64',
  family: 'linux',
  displayName: 'Alpine test',
  versionLabel: 'x64',
  architecture: 'x86_64',
  availability: 'ready',
  description: 'test guest',
  iconUrl: '/icon.svg',
  minMemoryMiB: 1024,
  imageRef: 'alpine-test-x64',
  mediaStrategy: 'bundled',
  launchProfiles: [
    {
      id: 'alpine-test-x64',
      engineId: 'v64',
      executionMode: 'browser',
      configuration: { memoryMiB: 1024, extra: { v64CpuCores: 2 } },
      hardwareProfile: {
        network: 'virtio',
        machine: 'pc',
        video: 'vga',
        input: 'ps2',
        disk: 'ide',
        audio: false,
        acpi: true,
      },
      readiness: { marker: 'lumiboot@lumiboot', channel: 'serial', timeoutMs: 10_000 },
      displayMode: 'text',
    },
  ],
  requirements: ['WebAssembly'],
  accent: '#000',
  accentRgb: '0,0,0',
  integrationNote: 'test',
};

const manifest: ImageManifest = {
  ref: 'alpine-test-x64',
  architecture: 'x86_64',
  memoryMiB: 1024,
  license: 'test',
  files: {
    disk: { url: '/images/alpine-test-x64/alpine.iso', size: 4096, sha256: 'a'.repeat(64) },
    bzimage: { url: '/images/alpine-test-x64/vmlinuz', size: 2048, sha256: 'b'.repeat(64) },
    initrd: { url: '/images/alpine-test-x64/initrd', size: 2048, sha256: 'c'.repeat(64) },
  },
};

const DISK_SIZE = 68_719_476_736;
const ESP_SIZE = 64 * 1024 * 1024;

/** Installed Windows 11 x64 disk with its OVMF NVRAM, as served locally. */
function localDiskManifest(withFirmware = true): LocalDiskManifest {
  return {
    version: 1,
    ref: 'windows-11-x64',
    displayName: 'Windows 11 x64',
    architecture: 'x86_64',
    memoryMiB: 4096,
    vgaMemoryMiB: 32,
    license: 'test',
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: '/images/windows-11-x64/disk.img',
      size: DISK_SIZE,
      mtimeMs: 1793400322475,
    },
    engine: { id: 'v64' },
    boot: {
      mode: 'disk-boot',
      url: '/images/windows-11-x64/disk.img',
      async: true,
      size: DISK_SIZE,
    },
    ...(withFirmware
      ? {
          firmware: {
            type: 'uefi' as const,
            vars: {
              fileName: 'uefi-vars.fd',
              url: '/images/windows-11-x64/uefi-vars.fd',
              size: 540672,
              mtimeMs: 1793399417613,
            },
          },
        }
      : {}),
  };
}

/** Same disk with an EFI System Partition declared (two-media layout). */
function localDiskManifestWithEsp(): LocalDiskManifest {
  return {
    ...localDiskManifest(),
    esp: { url: '/images/windows-11-x64/esp.img', size: ESP_SIZE },
  };
}

const windows11: OSDefinition = {
  ...system,
  id: 'windows-11-x64',
  slug: 'windows-11-x64',
  family: 'windows',
  displayName: 'Windows 11',
  versionLabel: '24H2',
  imageRef: 'windows-11-x64',
  launchProfiles: [
    {
      ...system.launchProfiles[0]!,
      id: 'windows-11-x64-v64',
      configuration: {
        memoryMiB: 4096,
        vgaMemoryMiB: 32,
        extra: {
          v64CpuCores: 4,
          v64Machine: 'q35',
          v64Firmware: 'uefi',
          v64CpuFeatures: 'x86-64-v2',
        },
      },
      hardwareProfile: {
        network: 'e1000',
        machine: 'q35',
        video: 'vga',
        input: 'ps2',
        disk: 'ide',
        audio: false,
        acpi: true,
      },
      readiness: { marker: 'disk-boot', mode: 'disk-boot', channel: 'vga', timeoutMs: 60_000 },
      displayMode: 'graphical',
    },
  ],
} as OSDefinition;

function runtime(): V64Runtime {
  return {
    add_listener: () => undefined,
    remove_listener: () => undefined,
    run: async () => undefined,
    stop: async () => undefined,
    destroy: async () => undefined,
    keyboard_send_scancodes: async () => undefined,
  };
}

/** A runtime whose bus records `keyboard-usage` and whose stop emits `emulator-stopped`. */
function runtimeWithBus(): { runtime: V64Runtime; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  const listeners = new Map<string, Set<(argument: never) => void>>();
  return {
    send,
    runtime: {
      bus: { send },
      add_listener: (event, listener) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      remove_listener: (event, listener) => {
        listeners.get(event)?.delete(listener);
      },
      run: async () => undefined,
      // libv86 announces its stop: the USB keyboard adapter detaches on that.
      stop: async () => {
        const set = listeners.get('emulator-stopped');
        if (set === undefined) return;
        for (const listener of set) listener(undefined as never);
      },
      destroy: async () => undefined,
      keyboard_send_scancodes: async () => undefined,
    },
  };
}

describe('V64Provider', () => {
  it('declares only the architecture actually integrated by this provider', () => {
    const provider = new V64Provider({ resolveManifest: async () => manifest });
    expect(provider.capabilities().architectures).toEqual(['x86_64']);
    expect(provider.canRun(system)).toBe(true);
    expect(provider.canRun({ ...system, architecture: 'arm64' })).toBe(false);
  });

  it('builds a JIT Worker configuration for the pinned Alpine media', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    // Every manifest URL carries a digest-derived version: no cached replay of old bytes.
    expect(options).toMatchObject({
      cpu_type: 'x86_64',
      cpu_worker: true,
      parallel: 'auto',
      cpu_cores: 2,
      experimental_smp_jit: true,
      graphics_adapter: 'bochs_vga',
      memory_size: 1024 * 1024 * 1024,
      cdrom: { url: '/images/alpine-test-x64/alpine.iso?v=aaaaaaaaaaaa', size: 4096 },
      bzimage: { url: '/images/alpine-test-x64/vmlinuz?v=bbbbbbbbbbbb', size: 2048 },
      initrd: { url: '/images/alpine-test-x64/initrd?v=cccccccccccc', size: 2048 },
    });
    expect(options?.bzimage?.size).toBe(2048);
    expect(options?.initrd?.size).toBe(2048);
    expect(options?.cdrom?.async).toBeUndefined();
    await instance.dispose();
  });

  it('boots a self-booting ISO from El-Torito without injecting kernel or initrd', async () => {
    // v64 hard-codes the injected initrd window at 64 MiB: a Fedora kernel that
    // decompresses above it is why the disc has to boot itself.
    const selfBooting: ImageManifest = { ...manifest, boot: { cdromOnly: true } };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => selfBooting });
    const instance = await provider.start(system, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options).toMatchObject({
      // Buffered whole: the ranged ATAPI path trips an IDE DMA HSM violation.
      cdrom: { url: '/images/alpine-test-x64/alpine.iso?v=aaaaaaaaaaaa', size: 4096 },
      boot_order: 0x123,
    });
    expect(options?.cdrom?.async).toBeUndefined();
    expect(options?.bzimage).toBeUndefined();
    expect(options?.initrd).toBeUndefined();
    expect(options?.cmdline).toBeUndefined();
    await instance.dispose();
  });

  it('extends an existing query with the version instead of replacing it', async () => {
    const versioned: ImageManifest = {
      ...manifest,
      files: {
        ...manifest.files,
        initrd: {
          url: '/images/alpine-test-x64/initrd?raw=1',
          size: 2048,
          sha256: 'c'.repeat(64),
        },
      },
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => versioned });
    const instance = await provider.start(system, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.initrd).toEqual({
      url: '/images/alpine-test-x64/initrd?raw=1&v=cccccccccccc',
      size: 2048,
    });
    await instance.dispose();
  });

  it('applies the profile `extra` when the caller only passes runtime options', async () => {
    // The web app passes `{ network, media, signal }` and nothing else: a
    // profile-declared adapter must still reach the engine, otherwise
    // `v64Graphics` in the catalogue is dead configuration.
    const profileDriven: OSDefinition = {
      ...system,
      launchProfiles: [
        {
          ...system.launchProfiles[0]!,
          configuration: {
            memoryMiB: 1024,
            extra: { v64CpuCores: 4, v64Graphics: 'vmware_svga', v64Machine: 'q35' },
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(profileDriven, document.createElement('div'), {
      signal: new AbortController().signal,
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.graphics_adapter).toBe('vmware_svga');
    expect(options?.graphics_adapter_path).toBe('/v64/v86-vmware-svga.js');
    expect(options?.cpu_cores).toBe(4);
    expect(options?.machine_type).toBe('q35');
    await instance.dispose();
  });

  it('lets the caller override the profile graphics adapter', async () => {
    const profileDriven: OSDefinition = {
      ...system,
      launchProfiles: [
        {
          ...system.launchProfiles[0]!,
          configuration: { memoryMiB: 1024, extra: { v64Graphics: 'vmware_svga' } },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(profileDriven, document.createElement('div'), {
      extra: { v64Graphics: 'virtio_gpu' },
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.graphics_adapter).toBe('virtio_gpu');
    expect(options?.graphics_adapter_path).toBe('/v64/v86-virtio-gpu.js');
    await instance.dispose();
  });

  it('splits memory above 2 GiB into a valid extended-memory multiple of 2 MiB', async () => {
    // libv86 throws "extended_memory_size must be a multiple of 2 MiB" in the CPU
    // worker before the machine starts, which left the Fedora XFCE profile black.
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'), {
      memoryMiB: 2048,
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.memory_size).toBe(2046 * 1024 * 1024);
    expect(options?.extended_memory_size).toBe(2 * 1024 * 1024);
    expect(
      ((options?.memory_size ?? 0) + (options?.extended_memory_size ?? 0)) / (1024 * 1024),
    ).toBe(2048);
    await instance.dispose();
  });

  it('leaves memory at or below 2047 MiB without extended memory', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'), {
      memoryMiB: 1024,
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.memory_size).toBe(1024 * 1024 * 1024);
    expect(options).not.toHaveProperty('extended_memory_size');
    await instance.dispose();
  });

  it('releases the engine and the network when the instance cannot be wired', async () => {
    const destroy = vi.fn(async () => undefined);
    const createEngine = vi.fn(async (_options: V64Options) => ({
      ...runtime(),
      add_listener: () => {
        throw new Error('listener registration failed');
      },
      destroy,
    }));
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });

    await expect(provider.start(system, document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
      message: expect.stringContaining('could not be wired'),
    });
    // No orphaned emulator: a wiring failure must destroy the runtime.
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('boots a local disk under UEFI on q35 without any SeaBIOS', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const resolveManifest = vi.fn(async () => manifest);
    const resolveLocalDiskManifest = vi.fn(async () => localDiskManifest());
    const provider = new V64Provider({
      createEngine,
      resolveManifest,
      resolveLocalDiskManifest,
    });
    const instance = await provider.start(windows11, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    // A disk-boot profile never asks for an image manifest.
    expect(resolveManifest).not.toHaveBeenCalled();
    expect(resolveLocalDiskManifest).toHaveBeenCalledWith('windows-11-x64', undefined);
    expect(options).toBeDefined();
    expect(options?.firmware).toEqual({
      type: 'uefi',
      code: { url: '/v64/ovmf-code.fd' },
      // The disk's own NVRAM keeps the Windows Boot Manager entry.
      vars: { url: '/images/windows-11-x64/uefi-vars.fd' },
    });
    expect(options).not.toHaveProperty('bios');
    expect(options).not.toHaveProperty('vga_bios');
    expect(options?.acpi).toBe(true);
    expect(options?.machine_type).toBe('q35');
    // q35 keeps the modern layout: no QEMU-compatible legacy mode needed.
    expect(options).not.toHaveProperty('qemu_compatible');
    // HPET stays opt-in: this profile does not ask for it.
    expect(options).not.toHaveProperty('hpet');
    expect(options?.cpu_features).toBe('x86-64-v2');
    expect(options?.hda).toEqual({
      url: '/images/windows-11-x64/disk.img',
      size: DISK_SIZE,
      async: true,
    });
    // Memory and VRAM come from the disk manifest.
    expect((options?.memory_size ?? 0) + (options?.extended_memory_size ?? 0)).toBe(
      4096 * 1024 * 1024,
    );
    expect(options?.vram_size).toBe(32 * 1024 * 1024);
    await instance.dispose();
  });

  it('enables the HPET only for a profile that asks for it', async () => {
    // Windows' HAL stalls in `HalpInitializeClock` on q35/ACPI without an HPET;
    // a QEMU comparison proved the device is what unblocks it.
    const hpetProfile: OSDefinition = {
      ...windows11,
      launchProfiles: [
        {
          ...windows11.launchProfiles[0]!,
          configuration: {
            memoryMiB: 4096,
            vgaMemoryMiB: 32,
            extra: {
              v64CpuCores: 4,
              v64Machine: 'q35',
              v64Firmware: 'uefi',
              v64Hpet: true,
            },
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });
    const instance = await provider.start(hpetProfile, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.machine_type).toBe('q35');
    expect(options?.acpi).toBe(true);
    expect(options?.hpet).toBe(true);
    await instance.dispose();
  });

  it('leaves the HPET out when neither the caller nor the profile asks for it', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.acpi).toBe(true);
    expect(options).not.toHaveProperty('hpet');
    await instance.dispose();
  });

  it('adds qemu_compatible on i440fx and falls back to the bundled OVMF vars', async () => {
    const i440fx: OSDefinition = {
      ...windows11,
      launchProfiles: [
        {
          ...windows11.launchProfiles[0]!,
          configuration: {
            memoryMiB: 2048,
            extra: { v64Firmware: 'uefi', v64Machine: 'i440fx' },
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(false),
    });
    const instance = await provider.start(i440fx, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.machine_type).toBe('i440fx');
    expect(options?.qemu_compatible).toBe(true);
    expect(options?.cpu_features).toBeUndefined();
    // Without a disk NVRAM the bundled OVMF vars are used.
    expect(options?.firmware?.vars?.url).toBe('/v64/ovmf-vars.fd');
    expect(options).not.toHaveProperty('bios');
    await instance.dispose();
  });

  it('keeps the single-hda layout for Windows 11 without an ESP', async () => {
    // Non-regression: the shipped Windows 11 disk declares no ESP, so the engine
    // configuration must stay byte-identical to the one before two-media support.
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });
    const instance = await provider.start(windows11, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options).not.toHaveProperty('hdb');
    expect(options?.hda).toEqual({
      url: '/images/windows-11-x64/disk.img',
      size: DISK_SIZE,
      async: true,
    });
    // Single-media layout still uses the disk's own NVRAM (Boot0001 -> SATA 0).
    expect(options?.firmware?.vars?.url).toBe('/images/windows-11-x64/uefi-vars.fd');
    expect(options).not.toHaveProperty('boot_order');
    await instance.dispose();
  });

  it('mounts a declared ESP on hda and the system disk on hdb', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifestWithEsp(),
    });
    const instance = await provider.start(windows11, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    // OVMF's Boot0001 entry targets SATA port 0: the ESP keeps hda, never hdb.
    expect(options?.hda).toEqual({
      url: '/images/windows-11-x64/esp.img',
      size: ESP_SIZE,
      async: true,
    });
    expect(options?.hdb).toEqual({
      url: '/images/windows-11-x64/disk.img',
      size: DISK_SIZE,
      async: true,
    });
    expect(options?.hda?.size).toBe(64 * 1024 * 1024);
    expect(options?.hdb?.size).toBe(DISK_SIZE);
    // Both drives stay lazily ranged: the disk is never fully downloaded.
    expect(options?.hda?.async).toBe(true);
    expect(options?.hdb?.async).toBe(true);
    // The declared NVRAM is still the one carrying Boot0001 -> SATA 0.
    expect(options?.firmware?.vars?.url).toBe('/images/windows-11-x64/uefi-vars.fd');
    expect(options).not.toHaveProperty('boot_order');
    // A two-media layout is still a whole-disk boot: no ISO, kernel or initrd.
    expect(options).not.toHaveProperty('cdrom');
    expect(options).not.toHaveProperty('bzimage');
    expect(options).not.toHaveProperty('initrd');
    await instance.dispose();
  });

  it('adds no USB controller unless a profile asks for one', async () => {
    // Non-regression: the USB plugin is opt-in, so an existing profile's engine
    // configuration carries no `usb` key at all (no controller, no plugin).
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });
    const alpine = await provider.start(system, document.createElement('div'));
    const alpineOptions = createEngine.mock.calls[0]?.[0];
    expect(alpineOptions).not.toHaveProperty('usb');
    await alpine.dispose();

    const windows = await provider.start(windows11, document.createElement('div'));
    const windowsOptions = createEngine.mock.calls[1]?.[0];
    expect(windowsOptions).not.toHaveProperty('usb');
    // Everything else about the Windows 11 configuration is untouched.
    expect(windowsOptions?.machine_type).toBe('q35');
    expect(windowsOptions?.firmware?.type).toBe('uefi');
    await windows.dispose();
  });

  it('maps a profile USB input request onto the engine USB device list', async () => {
    const usbProfile: OSDefinition = {
      ...system,
      launchProfiles: [
        {
          ...system.launchProfiles[0]!,
          configuration: {
            memoryMiB: 1024,
            extra: { v64UsbTablet: true, v64UsbKeyboard: true, v64UsbController: 'uhci' },
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(usbProfile, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.usb).toEqual({
      controller: 'uhci',
      tablet: true,
      keyboard: true,
      plugin_path: '/v64/v86-usb.js',
    });
    await instance.dispose();
  });

  it('lets the caller enable only the USB keyboard and defaults to UHCI', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'), {
      extra: { v64UsbKeyboard: true },
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.usb).toEqual({
      controller: 'uhci',
      tablet: false,
      keyboard: true,
      plugin_path: '/v64/v86-usb.js',
    });
    await instance.dispose();
  });

  it('keeps the USB controller off when no device is asked for', async () => {
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'), {
      extra: { v64UsbTablet: false, v64UsbKeyboard: false },
    });
    const options = createEngine.mock.calls[0]?.[0];

    expect(options).not.toHaveProperty('usb');
    await instance.dispose();
  });

  it('types the page keys into the guest USB keyboard when it is enabled', async () => {
    const { runtime: engine, send } = runtimeWithBus();
    const createEngine = vi.fn(async (_options: V64Options) => engine);
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'), {
      extra: { v64UsbKeyboard: true },
    });

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a' }));
    expect(send.mock.calls).toEqual([
      ['keyboard-usage', [0x04, true]],
      ['keyboard-usage', [0x04, false]],
    ]);

    // Stopping the engine detaches the adapter: no listener outlives the session.
    await instance.dispose();
    send.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the page keys away from an engine that has no USB keyboard', async () => {
    const { runtime: engine, send } = runtimeWithBus();
    const createEngine = vi.fn(async (_options: V64Options) => engine);
    const provider = new V64Provider({ createEngine, resolveManifest: async () => manifest });
    const instance = await provider.start(system, document.createElement('div'));

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    expect(send).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it('enables the emulated SMC on q35 and puts the guest offline', async () => {
    // macOS never leaves `Waiting for DSMOS...` without APP0001, and the SMC's
    // I/O ports are the NE2000's: an SMC profile has no network device at all.
    const smcProfile: OSDefinition = {
      ...windows11,
      launchProfiles: [
        {
          ...windows11.launchProfiles[0]!,
          configuration: {
            memoryMiB: 4096,
            vgaMemoryMiB: 32,
            extra: {
              v64CpuCores: 4,
              v64Machine: 'q35',
              v64Firmware: 'uefi',
              v64Smc: true,
            },
          },
          hardwareProfile: {
            ...windows11.launchProfiles[0]!.hardwareProfile!,
            network: 'virtio',
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });
    const instance = await provider.start(smcProfile, document.createElement('div'));
    const options = createEngine.mock.calls[0]?.[0];

    expect(options?.smc).toBe(true);
    // Forced offline, whatever the profile's transport is: the relay stays unused.
    expect(options?.net_device).toEqual({ type: 'none' });
    expect(options?.machine_type).toBe('q35');
    expect(options?.acpi).toBe(true);
    expect(options?.firmware?.type).toBe('uefi');
    await instance.dispose();
  });

  it('adds no smc key and no network change when no profile asks for the SMC', async () => {
    // Non-regression: Windows 11 and Alpine keep the exact engine configuration
    // they had before `v64Smc` existed, `v64Smc: false` included.
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });
    const stripMount = (options: V64Options | undefined): Record<string, unknown> => {
      const rest = { ...(options as V64Options) } as Record<string, unknown>;
      delete rest.screen;
      delete rest.serial_console;
      return rest;
    };

    const alpine = await provider.start(system, document.createElement('div'));
    const alpineOptions = createEngine.mock.calls[0]?.[0];
    expect(alpineOptions).not.toHaveProperty('smc');
    expect(alpineOptions).not.toHaveProperty('net_device');
    expect(alpineOptions?.machine_type).toBe('i440fx');
    await alpine.dispose();

    const windows = await provider.start(windows11, document.createElement('div'));
    const windowsOptions = createEngine.mock.calls[1]?.[0];
    expect(windowsOptions).not.toHaveProperty('smc');
    expect(windowsOptions).not.toHaveProperty('net_device');
    expect(windowsOptions?.machine_type).toBe('q35');
    await windows.dispose();

    const explicitOff = await provider.start(system, document.createElement('div'), {
      extra: { v64Smc: false },
    });
    expect(stripMount(createEngine.mock.calls[2]?.[0])).toEqual(stripMount(alpineOptions));
    await explicitOff.dispose();
  });

  it('refuses the SMC on i440FX instead of letting the engine reject the platform', async () => {
    const i440fxSmc: OSDefinition = {
      ...windows11,
      launchProfiles: [
        {
          ...windows11.launchProfiles[0]!,
          configuration: {
            memoryMiB: 2048,
            extra: { v64Machine: 'i440fx', v64Firmware: 'uefi', v64Smc: true },
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });

    await expect(provider.start(i440fxSmc, document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
      message: expect.stringContaining('needs machine_type "q35"'),
    });
    // Refused before the engine exists: nothing to clean up.
    expect(createEngine).not.toHaveBeenCalled();
  });

  it('refuses the SMC with an explicit NE2000 on the same I/O ports', async () => {
    const ne2kSmc: OSDefinition = {
      ...windows11,
      launchProfiles: [
        {
          ...windows11.launchProfiles[0]!,
          configuration: {
            memoryMiB: 4096,
            extra: { v64Machine: 'q35', v64Firmware: 'uefi', v64Smc: true },
          },
          hardwareProfile: {
            ...windows11.launchProfiles[0]!.hardwareProfile!,
            network: 'ne2k',
          },
        },
      ],
    };
    const createEngine = vi.fn(async (_options: V64Options) => runtime());
    const provider = new V64Provider({
      createEngine,
      resolveManifest: async () => manifest,
      resolveLocalDiskManifest: async () => localDiskManifest(),
    });

    await expect(provider.start(ne2kSmc, document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
      message: expect.stringContaining('NE2000 both use the I/O ports 0x300-0x31F'),
    });
    expect(createEngine).not.toHaveBeenCalled();
  });
});
