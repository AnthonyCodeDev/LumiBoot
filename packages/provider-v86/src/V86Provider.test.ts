import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import type { V86, V86Options } from 'v86';
import type { ImageManifest, LocalDiskManifest } from '@lumiboot/vm-assets';
import { V86Provider } from './V86Provider';
import type { V86ConsoleAdapter } from './console-adapter';

/**
 * Captures the network controllers actually created by the provider and spies on
 * their `dispose()`, without altering behavior (the real controller is called).
 * Used to prove that no failure path leaks a controller.
 */
const { createdControllers } = vi.hoisted(() => ({
  createdControllers: [] as Array<import('@lumiboot/vm-network').NetworkController>,
}));

vi.mock('@lumiboot/vm-network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lumiboot/vm-network')>();
  return {
    ...actual,
    createNetworkController: (options: import('@lumiboot/vm-network').NetworkControllerOptions) => {
      const controller = actual.createNetworkController(options);
      vi.spyOn(controller, 'dispose');
      createdControllers.push(controller);
      return controller;
    },
  };
});

const MiB = 1024 * 1024;

class FakeV86 {
  add_listener(): void {
    /* no real subscription in tests */
  }
  remove_listener(): void {
    /* no real subscription in tests */
  }
  async run(): Promise<void> {
    /* no-op */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
  async destroy(): Promise<void> {
    /* no-op */
  }
}

function makeOS(overrides: Partial<OSDefinition> = {}): OSDefinition {
  return {
    id: 'debian-12-i386',
    slug: 'debian-12-i386',
    family: 'linux',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    architecture: 'i386',
    availability: 'ready',
    description: 'desc',
    iconUrl: '/icons/os/debian.svg',
    minMemoryMiB: 128,
    imageRef: 'debian-12-i386',
    launchProfiles: [
      {
        id: 'default',
        engineId: 'v86',
        executionMode: 'browser',
        minMemoryMiB: 128,
        configuration: { memoryMiB: 512, vgaMemoryMiB: 16, bootDevice: 'disk' },
      },
    ],
    requirements: ['WebAssembly'],
    accent: '#ec4264',
    accentRgb: '236,66,100',
    integrationNote: 'note',
    ...overrides,
  };
}

function makeManifest(memoryMiB = 512): ImageManifest {
  return {
    ref: 'debian-12-i386',
    architecture: 'i386',
    memoryMiB,
    vgaMemoryMiB: 16,
    license: 'Debian GNU/Linux',
    files: {
      disk: {
        url: '/images/debian-12-i386/rootfs.img',
        sha256: 'a'.repeat(64),
        size: 2_000_000_000,
      },
      bzimage: {
        url: '/images/debian-12-i386/vmlinuz-686',
        sha256: 'b'.repeat(64),
        size: 5_000_000,
      },
      initrd: {
        url: '/images/debian-12-i386/initrd.img',
        sha256: 'c'.repeat(64),
        size: 30_000_000,
      },
    },
  };
}

function createConsoleStub(): V86ConsoleAdapter {
  return {
    screen: null,
    attach: vi.fn(() => ({
      screenContainer: document.createElement('div'),
      serialTextarea: document.createElement('textarea'),
    })),
    detach: vi.fn(),
  };
}

function makeDiskManifest(): LocalDiskManifest {
  return {
    version: 1,
    ref: 'windows-7-pro-sp1-x86',
    displayName: 'Windows 7 Professional SP1 x86',
    architecture: 'i386',
    memoryMiB: 1536,
    vgaMemoryMiB: 16,
    license: 'Local disk from the codebase',
    provenance: 'images/windows-7-pro-sp1-x86/disk.img',
    source: { path: 'images/windows-7-pro-sp1-x86/disk.img', size: 34_359_738_368, mtimeMs: 0 },
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: '/images/windows-7-pro-sp1-x86/disk.img',
      size: 34_359_738_368,
      mtimeMs: 0,
      sha256: 'd'.repeat(64),
    },
    engine: {
      id: 'v86',
      wasm: { url: '/v86/v86.wasm', size: 1, sha256: 'e'.repeat(64) },
      bios: {
        seabios: { url: '/v86/seabios.bin', size: 1, sha256: 'f'.repeat(64) },
        vgabios: { url: '/v86/vgabios.bin', size: 1, sha256: '0'.repeat(64) },
      },
    },
    boot: {
      mode: 'disk-boot',
      url: '/images/windows-7-pro-sp1-x86/disk.img',
      async: true,
      size: 34_359_738_368,
    },
  };
}

function setup(manifest: ImageManifest = makeManifest(), diskManifest?: LocalDiskManifest) {
  const captured: V86Options[] = [];
  const provider = new V86Provider({
    createEngine: (options) => {
      captured.push(options);
      return new FakeV86() as unknown as V86;
    },
    resolveManifest: async () => manifest,
    resolveDiskManifest: async () => diskManifest ?? makeDiskManifest(),
    createConsole: () => createConsoleStub(),
  });
  return { provider, captured };
}

describe('V86Provider', () => {
  beforeEach(() => {
    createdControllers.length = 0;
  });

  it('passes 512 MiB, an asynchronous disk and its real size to v86', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));

    const options = captured[0];
    expect(options?.memory_size).toBe(512 * MiB);
    expect(options?.vga_memory_size).toBe(16 * MiB);
    expect(options?.hda).toMatchObject({ async: true, size: 2_000_000_000 });
    expect(options?.autostart).toBe(false);
    expect(options?.cmdline).toContain('root=/dev/sda');
  });

  it('rejects a mount target that is not a DOM element', async () => {
    const { provider, captured } = setup();
    await expect(provider.start(makeOS(), {})).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('accepts 1536 MiB (not a power of two) as required by the Windows guest', async () => {
    const { provider, captured } = setup();
    const os = makeOS({
      launchProfiles: [
        {
          id: 'default',
          engineId: 'v86',
          executionMode: 'browser',
          configuration: { memoryMiB: 1536 },
        },
      ],
    });
    await provider.start(os, document.createElement('div'));
    // v86 rounds `create_memory` to 128 KiB: no power of two required.
    expect(captured[0]?.memory_size).toBe(1536 * MiB);
  });

  it('rejects memory outside the real v86 bounds (> 2048 MiB)', async () => {
    const { provider, captured } = setup();
    const os = makeOS({
      launchProfiles: [
        {
          id: 'default',
          engineId: 'v86',
          executionMode: 'browser',
          configuration: { memoryMiB: 4096 },
        },
      ],
    });
    await expect(provider.start(os, document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
    });
    expect(captured).toHaveLength(0);
  });

  it('fails cleanly if the v86 construction throws', async () => {
    const provider = new V86Provider({
      createEngine: () => {
        throw new Error('missing wasm');
      },
      resolveManifest: async () => makeManifest(),
      createConsole: () => createConsoleStub(),
    });
    await expect(provider.start(makeOS(), document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
    });
  });

  it('fails if the manifest does not contain the required files', async () => {
    const manifest = makeManifest();
    const broken: ImageManifest = { ...manifest, files: { disk: manifest.files['disk']! } };
    const { provider } = setup(broken);
    await expect(provider.start(makeOS(), document.createElement('div'))).rejects.toMatchObject({
      code: 'IMAGE_MISSING',
    });
  });

  it('by default (offline profile): no network card injected', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));
    expect(captured[0]?.net_device).toBeUndefined();
  });

  it('valid user-relay: injects a net_device with relay_url and the matching NIC', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'user-relay', relayUrl: 'wss://relay.example.com:8443/wisp' },
    });
    expect(captured[0]?.net_device).toEqual({
      relay_url: 'wisps://relay.example.com:8443/wisp',
      type: 'virtio',
    });
  });

  it('browser-fetch: injects the fetch backend', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toEqual({ relay_url: 'fetch', type: 'virtio' });
  });

  it('ne2k hardware profile: the card follows the catalog contract', async () => {
    const { provider, captured } = setup();
    const os = makeOS({
      launchProfiles: [
        {
          id: 'default',
          engineId: 'v86',
          executionMode: 'browser',
          hardwareProfile: { network: 'ne2k' },
        },
      ],
    });
    await provider.start(os, document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toEqual({ relay_url: 'fetch', type: 'ne2k' });
  });

  it('none hardware profile: no network card even with a transport', async () => {
    const { provider, captured } = setup();
    const os = makeOS({
      launchProfiles: [
        {
          id: 'default',
          engineId: 'v86',
          executionMode: 'browser',
          hardwareProfile: { network: 'none' },
        },
      ],
    });
    await provider.start(os, document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toBeUndefined();
  });

  it('unreachable relay: the start succeeds without blocking the lifecycle', async () => {
    const { provider, captured } = setup();
    const instance = await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'user-relay', relayUrl: 'wss://127.0.0.1:9/' },
    });

    // The translation to v86 stays correct: a real TLS WISP relay is targeted.
    expect(captured[0]?.net_device).toEqual({ relay_url: 'wisps://127.0.0.1:9/', type: 'virtio' });

    // Unreachability is observed at runtime by v86, never during `start()`: the
    // controller stays "configured" (never "error"), so a dead relay does not
    // prevent the emulator from starting.
    const controller = createdControllers[0];
    expect(controller?.snapshot().status).toBe('configured');
    expect(controller?.snapshot().status).not.toBe('error');

    // Stopping then releasing stays possible and idempotent: no blocking
    // resource survives the unreachable relay. The detach of the v86 listeners
    // (eth-transmit-end/eth-receive-end/net0-send) is covered by
    // `v86-instance.test.ts`.
    await instance.stop();
    await instance.dispose();
    await instance.dispose();
    expect(controller?.dispose).toHaveBeenCalledTimes(1);
  });

  it('user-relay without a valid URL: fails at start without building v86', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeOS(), document.createElement('div'), {
        network: { mode: 'user-relay' },
      }),
    ).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('local-network: fails at start', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeOS(), document.createElement('div'), {
        network: { mode: 'local-network' },
      }),
    ).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('v86 construction failure: disposes the network controller', async () => {
    const provider = new V86Provider({
      createEngine: () => {
        throw new Error('missing wasm');
      },
      resolveManifest: async () => makeManifest(),
      createConsole: () => createConsoleStub(),
    });
    await expect(provider.start(makeOS(), document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
    });
    expect(createdControllers).toHaveLength(1);
    expect(createdControllers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('cancellation during v86 construction: disposes the network controller', async () => {
    const abort = new AbortController();
    const provider = new V86Provider({
      createEngine: () => {
        abort.abort();
        return new FakeV86() as unknown as V86;
      },
      resolveManifest: async () => makeManifest(),
      createConsole: () => createConsoleStub(),
    });
    await expect(
      provider.start(makeOS(), document.createElement('div'), { signal: abort.signal }),
    ).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(createdControllers).toHaveLength(1);
    expect(createdControllers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('success with transport: the controller stays "configured", never connected/online', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toEqual({ relay_url: 'fetch', type: 'virtio' });

    const controller = createdControllers[0];
    expect(controller?.snapshot().status).toBe('configured');
    expect(controller?.snapshot().verified).toBe(false);
    expect(controller?.snapshot().status).not.toBe('connected');
    expect(controller?.snapshot().status).not.toBe('online');
    // The provider never calls `setStatus('connected'|'online')`: no fake
    // "connected" on `emulator-ready`, DHCP or a mere socket open.
    expect(controller?.dispose).not.toHaveBeenCalled();
  });

  it('offline by default: "offline" controller and no net_device', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));
    expect(captured[0]?.net_device).toBeUndefined();
    expect(createdControllers[0]?.snapshot().status).toBe('offline');
  });

  it('does not advertise snapshots (absent from VMInstance)', () => {
    const { provider } = setup();
    const capabilities = provider.capabilities();
    // `VMInstance` exposes no snapshot entry point: never promise RAM/disk to
    // the UI.
    expect(capabilities.ramSnapshots).toBe(false);
    expect(capabilities.diskSnapshots).toBe(false);
    expect(capabilities.partialDownload).toBe(true);
    expect(capabilities.configurableMemory).toBe(true);
  });
});

describe('V86Provider: imported media (Windows 7)', () => {
  function makeWindowsOS(): OSDefinition {
    return makeOS({
      id: 'windows-7-pro-sp1-x86',
      slug: 'windows-7-pro-sp1-x86',
      family: 'windows',
      mediaStrategy: 'user-import',
      architecture: 'i386',
      availability: 'resource-required',
      launchProfiles: [
        {
          id: 'windows-7-pro-sp1-x86',
          engineId: 'v86',
          executionMode: 'browser',
          minMemoryMiB: 1536,
          configuration: { memoryMiB: 1536, vgaMemoryMiB: 16, bootDevice: 'disk' },
          hardwareProfile: { network: 'ne2k', acpi: true },
          readiness: {
            marker: 'LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86',
            mode: 'disk-boot',
            channel: 'vga',
          },
        },
      ],
    });
  }

  it('boots the imported disk through BIOS (hda) without a Linux kernel', async () => {
    const { provider, captured } = setup();
    await provider.start(makeWindowsOS(), document.createElement('div'), {
      media: { kind: 'disk', url: 'blob:local-disk', size: 8_000_000_000, format: 'raw' },
    });

    const options = captured[0];
    expect(options?.hda).toMatchObject({
      url: 'blob:local-disk',
      async: true,
      size: 8_000_000_000,
    });
    // No kernel boot: no bzimage/initrd/cmdline.
    expect(options?.bzimage).toBeUndefined();
    expect(options?.initrd).toBeUndefined();
    expect(options?.cmdline).toBeUndefined();
    // ACPI enabled by the hardware profile (required by the Vista+ family).
    expect(options?.acpi).toBe(true);
    expect(options?.memory_size).toBe(1536 * MiB);
  });

  it('ISO media targets CD-ROM and CD-first boot order (never hda)', async () => {
    const { provider, captured } = setup();
    const liveOS = makeOS({
      id: 'live-iso',
      slug: 'live-iso',
      launchProfiles: [
        {
          id: 'live',
          engineId: 'v86',
          executionMode: 'browser',
          configuration: { memoryMiB: 512, vgaMemoryMiB: 16, bootDevice: 'cdrom' },
        },
      ],
    });
    await provider.start(liveOS, document.createElement('div'), {
      media: { kind: 'disk', url: 'blob:live.iso', size: 700_000_000, format: 'iso' },
    });

    const options = captured[0];
    expect(options?.cdrom).toMatchObject({
      url: 'blob:live.iso',
      async: true,
      size: 700_000_000,
    });
    // An ISO is never mounted as a hard disk.
    expect(options?.hda).toBeUndefined();
    // Boot order: CD first (CD_HARDDISK_FLOPPY = 0x123).
    expect(options?.boot_order).toBe(0x123);
  });

  it('installation ISO media (disk-boot profile): rejected without simulating persistence', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeWindowsOS(), document.createElement('div'), {
        media: { kind: 'disk', url: 'blob:win7.iso', size: 3_000_000_000, format: 'iso' },
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ENVIRONMENT' });
    // No emulator built: the limitation is reported before any mount.
    expect(captured).toHaveLength(0);
  });

  it('fails honestly (MEDIA_REQUIRED) without imported media', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeWindowsOS(), document.createElement('div')),
    ).rejects.toMatchObject({ code: 'MEDIA_REQUIRED' });
    expect(captured).toHaveLength(0);
  });
});

describe('V86Provider: bundled local RAW disk (Windows 7)', () => {
  function makeDiskBootOS(): OSDefinition {
    return makeOS({
      id: 'windows-7-pro-sp1-x86',
      slug: 'windows-7-pro-sp1-x86',
      family: 'windows',
      // No more `mediaStrategy: 'user-import'`: disk bundled in the codebase.
      imageRef: 'windows-7-pro-sp1-x86',
      architecture: 'i386',
      availability: 'planned',
      launchProfiles: [
        {
          id: 'windows-7-pro-sp1-x86',
          engineId: 'v86',
          executionMode: 'browser',
          minMemoryMiB: 1536,
          configuration: { memoryMiB: 1536, vgaMemoryMiB: 16, bootDevice: 'disk' },
          hardwareProfile: { network: 'ne2k', acpi: true },
          readiness: {
            marker: 'LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86',
            mode: 'disk-boot',
            channel: 'vga',
          },
        },
      ],
    });
  }

  it('boots the local manifest disk through BIOS (hda), without media or kernel', async () => {
    const { provider, captured } = setup(makeManifest(), makeDiskManifest());
    await provider.start(makeDiskBootOS(), document.createElement('div'));

    const options = captured[0];
    expect(options?.hda).toMatchObject({
      url: '/images/windows-7-pro-sp1-x86/disk.img',
      async: true,
      size: 34_359_738_368,
    });
    // No kernel boot: no bzimage/initrd/cmdline.
    expect(options?.bzimage).toBeUndefined();
    expect(options?.initrd).toBeUndefined();
    expect(options?.cmdline).toBeUndefined();
    // ACPI enabled by the hardware profile (required by the Vista+ family).
    expect(options?.acpi).toBe(true);
    expect(options?.memory_size).toBe(1536 * MiB);
  });
});

describe('V86Provider: bundled local RAW disk (Windows 10 x86)', () => {
  function makeWin10DiskManifest(): LocalDiskManifest {
    return {
      version: 1,
      ref: 'windows-10-x86',
      displayName: 'Windows 10 x86 (local disk)',
      architecture: 'i386',
      memoryMiB: 2048,
      vgaMemoryMiB: 16,
      license: 'Local disk from the codebase',
      provenance: 'images/windows-10-x86/disk.img',
      source: { path: 'images/windows-10-x86/disk.img', size: 20_000_000_000, mtimeMs: 0 },
      disk: {
        fileName: 'disk.img',
        format: 'raw',
        url: '/images/windows-10-x86/disk.img',
        size: 20_000_000_000,
        mtimeMs: 0,
        sha256: 'd'.repeat(64),
      },
      engine: {
        id: 'v86',
        wasm: { url: '/v86/v86.wasm', size: 1, sha256: 'e'.repeat(64) },
        bios: {
          seabios: { url: '/v86/seabios.bin', size: 1, sha256: 'f'.repeat(64) },
          vgabios: { url: '/v86/vgabios.bin', size: 1, sha256: '0'.repeat(64) },
        },
      },
      boot: {
        mode: 'disk-boot',
        url: '/images/windows-10-x86/disk.img',
        async: true,
        size: 20_000_000_000,
      },
    };
  }

  function makeWin10DiskBootOS(): OSDefinition {
    return makeOS({
      id: 'windows-10-x86',
      slug: 'windows-10-x86',
      family: 'windows',
      imageRef: 'windows-10-x86',
      architecture: 'i386',
      availability: 'planned',
      launchProfiles: [
        {
          id: 'windows-10-x86',
          engineId: 'v86',
          executionMode: 'browser',
          minMemoryMiB: 2048,
          configuration: { memoryMiB: 2048, vgaMemoryMiB: 16, bootDevice: 'disk' },
          hardwareProfile: { network: 'virtio', acpi: true },
          readiness: {
            marker: 'LUMIBOOT_DISK_BOOT:windows-10-x86',
            mode: 'disk-boot',
            channel: 'vga',
          },
        },
      ],
    });
  }

  it('boots the local disk through BIOS (hda/ACPI, 2048 MiB), without kernel or ISO', async () => {
    const { provider, captured } = setup(makeManifest(), makeWin10DiskManifest());
    await provider.start(makeWin10DiskBootOS(), document.createElement('div'));

    const options = captured[0];
    // RAW disk read through HTTP Range (`async`), 2048 MiB memory.
    expect(options?.hda).toMatchObject({
      url: '/images/windows-10-x86/disk.img',
      async: true,
      size: 20_000_000_000,
    });
    expect(options?.memory_size).toBe(2048 * MiB);
    // ACPI enabled by the hardware profile (NT Vista+ guests).
    expect(options?.acpi).toBe(true);
    // BIOS disk boot: no Linux kernel, never a CD-ROM/ISO.
    expect(options?.bzimage).toBeUndefined();
    expect(options?.initrd).toBeUndefined();
    expect(options?.cmdline).toBeUndefined();
    expect(options?.cdrom).toBeUndefined();
    expect(options?.boot_order).toBeUndefined();
  });

  it('virtio NIC driven by the catalog hardware profile', async () => {
    const { provider, captured } = setup(makeManifest(), makeWin10DiskManifest());
    await provider.start(makeWin10DiskBootOS(), document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toEqual({ relay_url: 'fetch', type: 'virtio' });
  });
});
