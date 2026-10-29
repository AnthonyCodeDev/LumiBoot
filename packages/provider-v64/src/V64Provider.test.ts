// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import type { ImageManifest } from '@lumiboot/vm-assets';
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
});
