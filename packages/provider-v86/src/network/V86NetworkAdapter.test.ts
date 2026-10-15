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

  it('user-relay : préserve le port et le chemin lors de la conversion wss->wisps', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: 'wss://relay.example.com:9443/a/b?x=1',
    });
    expect(device).toEqual({
      relay_url: 'wisps://relay.example.com:9443/a/b?x=1',
    });
  });

  it('user-relay : sans port ni chemin, URL.href normalise en « / » (schéma wisps)', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: 'wss://relay.example.com',
    });
    expect(device).toEqual({ relay_url: 'wisps://relay.example.com/' });
  });

  it('user-relay : le schéma wisps:// résultant n’est jamais un wss:// brut', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: 'wss://relay.example.com/wisp',
    });
    expect(device?.relay_url).toBe('wisps://relay.example.com/wisp');
    expect(device?.relay_url?.startsWith('wss://')).toBe(false);
  });

  it('user-relay : ws:// localhost reste refusé (le provider n’active pas l’insecure)', () => {
    expect(() =>
      toV86NetworkDevice({ mode: 'user-relay', relayUrl: 'ws://localhost:8080' }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }));
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

  it('local-proxy sans token : relais WISP local par défaut', () => {
    expect(toV86NetworkDevice({ mode: 'local-proxy' })).toEqual({
      relay_url: 'wisp://127.0.0.1:37892/wisp/',
    });
  });

  it('local-proxy avec token : query ?token conservée', () => {
    expect(toV86NetworkDevice({ mode: 'local-proxy', proxyToken: 'abc' })).toEqual({
      relay_url: 'wisp://127.0.0.1:37892/wisp/?token=abc',
    });
  });

  it('local-proxy avec URL loopback personnalisée : host/port conservés', () => {
    expect(
      toV86NetworkDevice({
        mode: 'local-proxy',
        proxyUrl: 'http://127.0.0.1:40000',
        proxyToken: 'abc',
      }),
    ).toEqual({ relay_url: 'wisp://127.0.0.1:40000/wisp/?token=abc' });
  });

  it('local-proxy avec URL non loopback : rejette avec NETWORK_INVALID_PROXY_URL', () => {
    expect(() =>
      toV86NetworkDevice({
        mode: 'local-proxy',
        proxyUrl: 'http://example.com:37892',
      }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_PROXY_URL' }));
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
