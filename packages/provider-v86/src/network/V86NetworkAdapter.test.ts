import { describe, expect, it } from 'vitest';
import { createNetworkController, defaultNetworkProfile } from '@lumiboot/vm-network';
import {
  attachNetworkDiagnostics,
  toV86NetworkDevice,
  toV86NetworkDeviceType,
  type NetworkEventSource,
} from './V86NetworkAdapter';
import { RELAY_ORIGIN, RELAY_WSS, RELAY_WSS_PATH } from '../testing/fixtures';

/** A non-default port and a path: the subject of the conversion test below. */
const RELAY_CUSTOM_PORT_URL = `wss://${RELAY_ORIGIN}:9443/a/b?x=1`;
/** `ws://` on loopback: the provider never enables insecure relays. */
const LOCAL_INSECURE_RELAY = 'ws://localhost:8080';
/** A loopback proxy on a non-default port: host and port must be preserved. */
const CUSTOM_LOOPBACK_PROXY_URL = 'http://127.0.0.1:40000';

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

describe('toV86NetworkDevice', () => {
  it('offline: no network card', () => {
    expect(toV86NetworkDevice({ mode: 'offline' })).toBeUndefined();
  });

  it('browser-fetch: native fetch backend', () => {
    expect(toV86NetworkDevice({ mode: 'browser-fetch' })).toEqual({ relay_url: 'fetch' });
  });

  it('user-relay: converts the validated wss into a wisps:// understood by v86', () => {
    const device = toV86NetworkDevice({ mode: 'user-relay', relayUrl: RELAY_WSS_PATH });
    expect(device).toEqual({ relay_url: `wisps://${RELAY_ORIGIN}:8443/wisp` });
  });

  it('user-relay: preserves port and path during the wss->wisps conversion', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: RELAY_CUSTOM_PORT_URL,
    });
    expect(device).toEqual({
      relay_url: `wisps://${RELAY_ORIGIN}:9443/a/b?x=1`,
    });
  });

  it('user-relay: without port or path, URL.href normalizes to "/" (wisps scheme)', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: RELAY_WSS,
    });
    expect(device).toEqual({ relay_url: `wisps://${RELAY_ORIGIN}/` });
  });

  it('user-relay: the resulting wisps:// scheme is never a raw wss://', () => {
    const device = toV86NetworkDevice({
      mode: 'user-relay',
      relayUrl: `${RELAY_WSS}/wisp`,
    });
    expect(device?.relay_url).toBe(`wisps://${RELAY_ORIGIN}/wisp`);
    expect(device?.relay_url?.startsWith('wss://')).toBe(false);
  });

  it('user-relay: ws:// localhost stays rejected (the provider does not enable insecure)', () => {
    expect(() =>
      toV86NetworkDevice({ mode: 'user-relay', relayUrl: LOCAL_INSECURE_RELAY }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }));
  });

  it('user-relay without a valid URL: rejects with NETWORK_INVALID_RELAY_URL', () => {
    expect(() => toV86NetworkDevice({ mode: 'user-relay' })).toThrowError(
      expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }),
    );
    expect(() =>
      toV86NetworkDevice({ mode: 'user-relay', relayUrl: `http://${RELAY_ORIGIN}` }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_RELAY_URL' }));
  });

  it('local-network: not implemented', () => {
    expect(() => toV86NetworkDevice({ mode: 'local-network' })).toThrowError(
      expect.objectContaining({ code: 'NETWORK_UNSUPPORTED_MODE' }),
    );
  });

  it('local-proxy without token: default local WISP relay', () => {
    expect(toV86NetworkDevice({ mode: 'local-proxy' })).toEqual({
      relay_url: 'wisp://127.0.0.1:37892/wisp/',
    });
  });

  it('local-proxy with token: ?token query preserved', () => {
    expect(toV86NetworkDevice({ mode: 'local-proxy', proxyToken: 'abc' })).toEqual({
      relay_url: 'wisp://127.0.0.1:37892/wisp/?token=abc',
    });
  });

  it('local-proxy with a custom loopback URL: host/port preserved', () => {
    expect(
      toV86NetworkDevice({
        mode: 'local-proxy',
        proxyUrl: CUSTOM_LOOPBACK_PROXY_URL,
        proxyToken: 'abc',
      }),
    ).toEqual({ relay_url: 'wisp://127.0.0.1:40000/wisp/?token=abc' });
  });

  it('local-proxy with a non-loopback URL: rejects with NETWORK_INVALID_PROXY_URL', () => {
    expect(() =>
      toV86NetworkDevice({
        mode: 'local-proxy',
        proxyUrl: 'http://example.com:37892',
      }),
    ).toThrowError(expect.objectContaining({ code: 'NETWORK_INVALID_PROXY_URL' }));
  });
});

describe('toV86NetworkDeviceType', () => {
  it('absent hardware profile: documented virtio default', () => {
    expect(toV86NetworkDeviceType(undefined)).toBe('virtio');
  });

  it('virtio network: virtio NIC (modern kernels)', () => {
    expect(toV86NetworkDeviceType({ network: 'virtio' })).toBe('virtio');
  });

  it('ne2k network: NE2000 NIC (legacy guests)', () => {
    expect(toV86NetworkDeviceType({ network: 'ne2k' })).toBe('ne2k');
  });

  it('none network: no network card', () => {
    expect(toV86NetworkDeviceType({ network: 'none' })).toBeUndefined();
  });

  it('the translation only depends on the contract, not on the system', () => {
    // The same hardware profile yields the same card whatever the guest.
    expect(toV86NetworkDeviceType({ network: 'ne2k', machine: 'pc' })).toBe('ne2k');
    expect(toV86NetworkDeviceType({ network: 'virtio', audio: true })).toBe('virtio');
  });
});

describe('attachNetworkDiagnostics', () => {
  it('counts tx/rx from v86 events and detaches cleanly', () => {
    const controller = createNetworkController({ profile: defaultNetworkProfile });
    const emitter = new FakeEmitter();
    const detach = attachNetworkDiagnostics(emitter as unknown as NetworkEventSource, controller);

    emitter.emit('eth-transmit-end', [128]);
    expect(controller.snapshot().txBytes).toBe(128);

    emitter.emit('eth-receive-end', [256]);
    expect(controller.snapshot().rxBytes).toBe(256);

    emitter.emit('net0-send', new Uint8Array(64));
    expect(controller.snapshot().txBytes).toBe(192);

    // v86 also emits eth-transmit-end for the same frame: no double counting.
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
