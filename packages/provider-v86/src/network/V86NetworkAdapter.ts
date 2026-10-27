import { DEFAULT_HARDWARE_PROFILE, type HardwareProfile } from '@lumiboot/contracts';
import {
  DEFAULT_PROXY_URL,
  NetworkError,
  buildProxyWispUrl,
  validateRelayUrl,
  type NetworkController,
  type NetworkProfile,
} from '@lumiboot/vm-network';
import type { Event as V86Event, V86Options } from 'v86';

/** Single point of contact between `@lumiboot/vm-network` and `v86`. */

export type V86NetworkDevice = NonNullable<V86Options['net_device']>;

export type V86NetworkDeviceType = NonNullable<V86NetworkDevice['type']>;

export type V86NetworkEventName = 'eth-transmit-end' | 'eth-receive-end' | 'net0-send';

/**
 * Minimal event source; `V86` satisfies it structurally.
 */
export interface NetworkEventSource {
  add_listener<T extends V86NetworkEventName>(
    event: T,
    listener: (argument: V86Event[T]) => void,
  ): void;
  remove_listener<T extends V86NetworkEventName>(
    event: T,
    listener: (argument: V86Event[T]) => void,
  ): void;
}

/**
 * v86 only treats `wisp://` and `wisps://` as Wisp relays; a raw `wss://` URL
 * falls back to the legacy WebSocket relay.
 */
function toWispRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^wss:/i, 'wisps:').replace(/^ws:/i, 'wisp:');
}

/**
 * The NIC type is merged separately from the hardware profile.
 *
 * @throws NetworkError on invalid relay or proxy address, or unsupported mode.
 */
export function toV86NetworkDevice(profile: NetworkProfile): V86NetworkDevice | undefined {
  switch (profile.mode) {
    case 'offline':
      return undefined;
    case 'browser-fetch':
      return { relay_url: 'fetch' };
    case 'user-relay': {
      const validation = validateRelayUrl(profile.relayUrl);
      if (!validation.ok || validation.url === undefined) {
        throw new NetworkError(
          'NETWORK_INVALID_RELAY_URL',
          validation.error ?? 'Invalid relay address.',
        );
      }
      return { relay_url: toWispRelayUrl(validation.url) };
    }
    case 'local-proxy': {
      let url: string;
      try {
        url = buildProxyWispUrl(profile.proxyUrl ?? DEFAULT_PROXY_URL, profile.proxyToken);
      } catch (error) {
        throw new NetworkError(
          'NETWORK_INVALID_PROXY_URL',
          error instanceof Error ? error.message : 'Invalid local network proxy address.',
        );
      }
      return { relay_url: toWispRelayUrl(url) };
    }
    case 'local-network':
      throw new NetworkError(
        'NETWORK_UNSUPPORTED_MODE',
        'The "local-network" mode is not implemented for v86.',
      );
  }
}

const DEVICE_TYPE_BY_NETWORK: Readonly<
  Record<HardwareProfile['network'], V86NetworkDeviceType | undefined>
> = {
  virtio: 'virtio',
  ne2k: 'ne2k',
  none: undefined,
};

export function toV86NetworkDeviceType(
  hardware: HardwareProfile | undefined,
): V86NetworkDeviceType | undefined {
  const network = hardware?.network ?? DEFAULT_HARDWARE_PROFILE.network;
  return DEVICE_TYPE_BY_NETWORK[network];
}

/**
 * v86 emits both `net0-send` and `eth-transmit-end` per frame; counting both
 * would double the traffic. Returns a detach function.
 */
export function attachNetworkDiagnostics(
  emulator: NetworkEventSource,
  controller: NetworkController,
): () => void {
  let observedFrameSend = false;

  const onTransmitEnd = (argument: V86Event['eth-transmit-end']): void => {
    if (observedFrameSend) return;
    controller.reportTx(argument[0]);
  };
  const onReceiveEnd = (argument: V86Event['eth-receive-end']): void => {
    controller.reportRx(argument[0]);
  };
  const onFrameSend = (frame: V86Event['net0-send']): void => {
    observedFrameSend = true;
    controller.reportTx(frame.byteLength);
  };

  emulator.add_listener('eth-transmit-end', onTransmitEnd);
  emulator.add_listener('eth-receive-end', onReceiveEnd);
  emulator.add_listener('net0-send', onFrameSend);

  return () => {
    emulator.remove_listener('eth-transmit-end', onTransmitEnd);
    emulator.remove_listener('eth-receive-end', onReceiveEnd);
    emulator.remove_listener('net0-send', onFrameSend);
  };
}
