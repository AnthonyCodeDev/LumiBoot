import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { createNetworkController, defaultNetworkProfile } from '@lumiboot/vm-network';
import {
  attachNetworkDiagnostics,
  resolveNetworkDevice,
  toV86NetworkDevice,
  type NetworkEventSource,
} from './V86NetworkAdapter';

type Listener = (arg: unknown) => void;

class FakeEmitter {
  readonly #listeners = new Map<string, Set<Listener>>();

  add_listener(event: string, listener: Listener): void {
    const set = this.#listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(event, set);
  }

  remove_listener(event: string, listener: Listener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  emit(event: string, arg: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

function makeOS(overrides: Partial<OSDefinition> = {}): OSDefinition {
  return {
    id: 'sample',
    slug: 'sample',
    family: 'linux',
    displayName: 'Sample',
    versionLabel: '1',
    architecture: 'i386',
    availability: 'ready',
    description: 'desc',
    iconUrl: '/icons/os/sample.svg',
    minMemoryMiB: 128,
    imageRef: 'sample',
    launchProfiles: [
      { id: 'default', engineId: 'v86', executionMode: 'browser', minMemoryMiB: 128 },
    ],
    requirements: ['WebAssembly'],
    accent: '#000000',
    accentRgb: '0,0,0',
    integrationNote: 'note',
    ...overrides,
  };
}

describe('toV86NetworkDevice', () => {
  it('offline : aucune carte réseau', () => {
    expect(toV86NetworkDevice({ mode: 'offline' })).toBeUndefined();
  });

  it('browser-fetch : backend fetch natif', () => {
    expect(toV86NetworkDevice({ mode: 'browser-fetch' })).toEqual({ relay_url: 'fetch' });
  });

  it('user-relay : convertit le wss validé en wisps:// compris par v86', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: 'wss://relay.example.com:8443/wisp',
    });
    expect(device).toEqual({ relay_url: 'wisps://relay.example.com:8443/wisp' });
  });

  it('user-relay sans URL valide : rejette avec NETWORK_INVALID_RELAY_URL', () => {
    expect(() => toV86NetworkDevice({ mode: 'user-relay' })).toThrowError(
      expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }),
    );
    expect(() =>
      toV86NetworkDevice({ mode: 'user-relay', relayUrl: 'http://relay.example.com' }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }));
  });

  it('local-network : non implémenté', () => {
    expect(() => toV86NetworkDevice({ mode: 'local-network' })).toThrowError(
      expect.objectContaining({ code: 'NETWORK_UNSUPPORTED_MODE' }),
    );
  });
});

describe('resolveNetworkDevice', () => {
  it('Debian 12 (debian-12-i386) : virtio', () => {
    expect(
      resolveNetworkDevice(
        makeOS({ id: 'debian-12-i386', family: 'linux', versionLabel: '12 Bookworm' }),
      ),
    ).toBe('virtio');
  });

  it('OS ancien tabulé (windows-7-x86) : ne2k', () => {
    expect(
      resolveNetworkDevice(makeOS({ id: 'windows-7-x86', family: 'windows', versionLabel: '7' })),
    ).toBe('ne2k');
  });

  it('Windows 32 bits non tabulé : heuristique legacy → ne2k', () => {
    expect(
      resolveNetworkDevice(makeOS({ id: 'windows-old', family: 'windows', architecture: 'i386' })),
    ).toBe('ne2k');
  });

  it('système inconnu : virtio par défaut (adapté à v86)', () => {
    expect(resolveNetworkDevice(makeOS({ id: 'mystery', family: 'linux' }))).toBe('virtio');
  });

  it('surcharge explicite prioritaire sur table et heuristique', () => {
    expect(resolveNetworkDevice(makeOS({ id: 'debian-12-i386' }), 'ne2k')).toBe('ne2k');
  });
});

describe('attachNetworkDiagnostics', () => {
  it('compte tx/rx depuis les événements v86 et se détache proprement', () => {
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    const emitter = new FakeEmitter();
    const detach = attachNetworkDiagnostics(emitter as unknown as NetworkEventSource, controller);

    emitter.emit('eth-transmit-end', [128]);
    expect(controller.snapshot().txBytes).toBe(128);

    emitter.emit('eth-receive-end', [256]);
    expect(controller.snapshot().rxBytes).toBe(256);

    emitter.emit('net0-send', new Uint8Array(64));
    expect(controller.snapshot().txBytes).toBe(192);

    // v86 émet aussi eth-transmit-end pour la même trame : pas de double comptage.
    emitter.emit('eth-transmit-end', [128]);
    expect(controller.snapshot().txBytes).toBe(192);

    expect(emitter.listenerCount('eth-transmit-end')).toBe(1);
    expect(emitter.listenerCount('eth-receive-end')).toBe(1);
    expect(emitter.listenerCount('net0-send')).toBe(1);

    detach();
    expect(emitter.listenerCount('eth-transmit-end')).toBe(0);
    expect(emitter.listenerCount('eth-receive-end')).toBe(0);
    expect(emitter.listenerCount('net0-send')).toBe(0);

    emitter.emit('net0-send', new Uint8Array(16));
    expect(controller.snapshot().txBytes).toBe(192);
  });
});
