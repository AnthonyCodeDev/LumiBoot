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

    expect(options).toMatchObject({
      cpu_type: 'x86_64',
      cpu_worker: true,
      parallel: 'auto',
      cpu_cores: 2,
      experimental_smp_jit: true,
      graphics_adapter: 'bochs_vga',
      memory_size: 1024 * 1024 * 1024,
      cdrom: { url: '/images/alpine-test-x64/alpine.iso', size: 4096 },
      bzimage: { url: '/images/alpine-test-x64/vmlinuz' },
      initrd: { url: '/images/alpine-test-x64/initrd' },
    });
    expect(options?.cdrom?.async).toBeUndefined();
    await instance.dispose();
  });
});
