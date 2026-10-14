import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import type { V86, V86Options } from 'v86';
import type { ImageManifest } from '@lumiboot/vm-assets';
import { V86Provider } from './V86Provider';
import type { V86ConsoleAdapter } from './console-adapter';

const MiB = 1024 * 1024;

class FakeV86 {
  add_listener(): void {
    /* aucun abonnement réel en test */
  }
  remove_listener(): void {
    /* aucun abonnement réel en test */
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
    attach: vi.fn(() => ({
      screenContainer: document.createElement('div'),
      serialTextarea: document.createElement('textarea'),
    })),
    detach: vi.fn(),
  };
}

function setup(manifest: ImageManifest = makeManifest()) {
  const captured: V86Options[] = [];
  const provider = new V86Provider({
    createEngine: (options) => {
      captured.push(options);
      return new FakeV86() as unknown as V86;
    },
    resolveManifest: async () => manifest,
    createConsole: () => createConsoleStub(),
  });
  return { provider, captured };
}

describe('V86Provider', () => {
  it('transmet 512 MiB, un disque asynchrone et sa taille réelle à v86', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));

    const options = captured[0];
    expect(options?.memory_size).toBe(512 * MiB);
    expect(options?.vga_memory_size).toBe(16 * MiB);
    expect(options?.hda).toMatchObject({ async: true, size: 2_000_000_000 });
    expect(options?.autostart).toBe(false);
    expect(options?.cmdline).toContain('root=/dev/sda');
  });

  it('refuse une cible de montage qui n’est pas un élément DOM', async () => {
    const { provider, captured } = setup();
    await expect(provider.start(makeOS(), {})).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('refuse une mémoire qui n’est pas une puissance de deux', async () => {
    const { provider, captured } = setup();
    const os = makeOS({
      launchProfiles: [
        {
          id: 'default',
          engineId: 'v86',
          executionMode: 'browser',
          configuration: { memoryMiB: 768 },
        },
      ],
    });
    await expect(provider.start(os, document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
    });
    expect(captured).toHaveLength(0);
  });

  it('échoue proprement si la construction de v86 jette', async () => {
    const provider = new V86Provider({
      createEngine: () => {
        throw new Error('wasm manquant');
      },
      resolveManifest: async () => makeManifest(),
      createConsole: () => createConsoleStub(),
    });
    await expect(provider.start(makeOS(), document.createElement('div'))).rejects.toMatchObject({
      code: 'START_FAILED',
    });
  });

  it('échoue si le manifeste ne contient pas les fichiers requis', async () => {
    const manifest = makeManifest();
    const broken: ImageManifest = { ...manifest, files: { disk: manifest.files['disk']! } };
    const { provider } = setup(broken);
    await expect(provider.start(makeOS(), document.createElement('div'))).rejects.toMatchObject({
      code: 'IMAGE_MISSING',
    });
  });
});
