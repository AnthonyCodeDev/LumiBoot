import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import type { V86, V86Options } from 'v86';
import type { ImageManifest } from '@lumiboot/vm-assets';
import { V86Provider } from './V86Provider';
import type { V86ConsoleAdapter } from './console-adapter';

/**
 * Capture les contrôleurs réseau réellement créés par le provider et espionne
 * leur `dispose()`, sans altérer le comportement (le vrai contrôleur est
 * appelé). Sert à prouver qu'aucun chemin d'échec ne fuit de contrôleur.
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
  beforeEach(() => {
    createdControllers.length = 0;
  });

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

  it('par défaut (profil offline) : aucune carte réseau injectée', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));
    expect(captured[0]?.net_device).toBeUndefined();
  });

  it('user-relay valide : injecte un net_device avec relay_url et la NIC adaptée', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'user-relay', relayUrl: 'wss://relay.example.com:8443/wisp' },
    });
    expect(captured[0]?.net_device).toEqual({
      relay_url: 'wisps://relay.example.com:8443/wisp',
      type: 'virtio',
    });
  });

  it('browser-fetch : injecte le backend fetch', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'browser-fetch' },
    });
    expect(captured[0]?.net_device).toEqual({ relay_url: 'fetch', type: 'virtio' });
  });

  it('profil matériel ne2k : la carte suit le contrat du catalogue', async () => {
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

  it('profil matériel none : aucune carte réseau même avec un transport', async () => {
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

  it('relais injoignable : le démarrage aboutit sans bloquer le cycle de vie', async () => {
    const { provider, captured } = setup();
    const instance = await provider.start(makeOS(), document.createElement('div'), {
      network: { mode: 'user-relay', relayUrl: 'wss://127.0.0.1:9/' },
    });

    // La traduction vers v86 reste correcte : un vrai relais WISP TLS est visé.
    expect(captured[0]?.net_device).toEqual({ relay_url: 'wisps://127.0.0.1:9/', type: 'virtio' });

    // L'injoignabilité est constatée à l'exécution par v86, jamais pendant
    // `start()` : le contrôleur reste « configured » (jamais « error »), donc
    // un relais mort n'empêche pas l'émulateur de démarrer.
    const controller = createdControllers[0];
    expect(controller?.snapshot().status).toBe('configured');
    expect(controller?.snapshot().status).not.toBe('error');

    // Arrêter puis libérer reste possible et idempotent : aucune ressource
    // bloquante ne survit au relais injoignable. Le détachement des écouteurs
    // v86 (eth-transmit-end/eth-receive-end/net0-send) est couvert par
    // `v86-instance.test.ts`.
    await instance.stop();
    await instance.dispose();
    await instance.dispose();
    expect(controller?.dispose).toHaveBeenCalledTimes(1);
  });

  it('user-relay sans URL valide : échoue au démarrage sans construire v86', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeOS(), document.createElement('div'), {
        network: { mode: 'user-relay' },
      }),
    ).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('local-network : échoue au démarrage', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeOS(), document.createElement('div'), {
        network: { mode: 'local-network' },
      }),
    ).rejects.toMatchObject({ code: 'START_FAILED' });
    expect(captured).toHaveLength(0);
  });

  it('échec de construction de v86 : dispose le contrôleur réseau', async () => {
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
    expect(createdControllers).toHaveLength(1);
    expect(createdControllers[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('annulation pendant la construction de v86 : dispose le contrôleur réseau', async () => {
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

  it('succès avec transport : le contrôleur reste « configured », jamais connected/online', async () => {
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
    // Le provider n'appelle jamais `setStatus('connected'|'online')` : aucun
    // faux « connecté » sur `emulator-ready`, DHCP ou simple ouverture de socket.
    expect(controller?.dispose).not.toHaveBeenCalled();
  });

  it('offline par défaut : contrôleur « offline » et aucun net_device', async () => {
    const { provider, captured } = setup();
    await provider.start(makeOS(), document.createElement('div'));
    expect(captured[0]?.net_device).toBeUndefined();
    expect(createdControllers[0]?.snapshot().status).toBe('offline');
  });
});

describe('V86Provider : média importé (Windows 7)', () => {
  function makeWindowsOS(): OSDefinition {
    return makeOS({
      id: 'windows-7-x86',
      slug: 'windows-7-x86',
      family: 'windows',
      mediaStrategy: 'user-import',
      architecture: 'i386',
      availability: 'resource-required',
      launchProfiles: [
        {
          id: 'windows-7-x86',
          engineId: 'v86',
          executionMode: 'browser',
          minMemoryMiB: 1024,
          configuration: { memoryMiB: 1024, vgaMemoryMiB: 16, bootDevice: 'disk' },
          hardwareProfile: { network: 'ne2k', acpi: true },
          readiness: {
            marker: 'LUMIBOOT_DISK_BOOT:windows-7-x86',
            mode: 'disk-boot',
            channel: 'vga',
          },
        },
      ],
    });
  }

  it('démarre le disque importé en BIOS (hda) sans noyau Linux', async () => {
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
    // Aucun démarrage par noyau : pas de bzimage/initrd/cmdline.
    expect(options?.bzimage).toBeUndefined();
    expect(options?.initrd).toBeUndefined();
    expect(options?.cmdline).toBeUndefined();
    // ACPI activée par le profil matériel (requis par la famille Vista+).
    expect(options?.acpi).toBe(true);
    expect(options?.memory_size).toBe(1024 * MiB);
  });

  it('échoue honnêtement (MEDIA_REQUIRED) sans média importé', async () => {
    const { provider, captured } = setup();
    await expect(
      provider.start(makeWindowsOS(), document.createElement('div')),
    ).rejects.toMatchObject({ code: 'MEDIA_REQUIRED' });
    expect(captured).toHaveLength(0);
  });
});
