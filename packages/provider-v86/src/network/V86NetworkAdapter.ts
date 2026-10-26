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

/**
 * Translation of LumiBoot network profiles to the v86 network layer.
 *
 * This module is deliberately isolated: no dependency on React, no dependency
 * on a particular guest system (Debian or other). It is the single point of
 * contact between `@lumiboot/vm-network` and `v86`.
 */

/** v86 network card (`V86NetworkDevice` is not exported directly by v86). */
export type V86NetworkDevice = NonNullable<V86Options['net_device']>;

/** Type of emulated card provided to the guest system. */
export type V86NetworkDeviceType = NonNullable<V86NetworkDevice['type']>;

/** Network events used for diagnostics (cf. `V86Event`). */
export type V86NetworkEventName = 'eth-transmit-end' | 'eth-receive-end' | 'net0-send';

/**
 * Minimal event source: only the network notifications useful for diagnostics.
 * `V86` satisfies it structurally, and a test emitter does not need to implement
 * the whole emulator.
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
 * LumiBoot -> v86 mapping, verified against the installed version
 * `v86@0.5.471+g94faf3d` (`node_modules/v86/build/libv86.mjs`).
 *
 * v86 resolves `options.network_relay_url || options.net_device.relay_url` as
 * follows:
 *   - `"fetch"`     -> native browser fetch backend (class `Xb`);
 *   - `"inbrowser"` -> in-memory network backend (class `rc`);
 *   - `"wisp://…"`  -> Wisp client over `ws://` (class `$b`);
 *   - `"wisps://…"` -> Wisp client over `wss://` (class `$b`);
 *   - anything else -> legacy WebSocket relay (class `pb`).
 *
 * LumiBoot modes:
 *   - `offline` / `browser-fetch` / `user-relay`: see
 *     {@link toV86NetworkDevice};
 *   - `local-proxy`: local WISP relay of the local network proxy
 *     (`wisp://127.0.0.1:37892/wisp/`), derived from `proxyUrl` (+ runtime
 *     `proxyToken`) through `buildProxyWispUrl`, then converted by
 *     `toWispRelayUrl` like the other relays.
 *
 * `network_relay_url` is marked `@deprecated` in `v86.d.ts` in favor of
 * `net_device`: LumiBoot therefore only uses `net_device.relay_url`.
 *
 * The Wisp client builds its WebSocket through `$b.prototype.register_ws`:
 *   `new WebSocket(url.replace("wisp://","ws://").replace("wisps://","wss://"))`
 * `wisps://` is thus the scheme of a **TLS** Wisp relay (`wss://`), and a raw
 * `wss://…` URL is NOT recognized as Wisp (it would fall back to the legacy
 * relay `pb`). LumiBoot validates its relays as `wss://`
 * ({@link validateRelayUrl}), so the conversion is faithful:
 *   - `wss://host:port/path[…]` -> `wisps://host:port/path[…]`;
 *   - `ws://host:port/path[…]`  -> `wisp://host:port/path[…]` (only if the
 *     validation explicitly tolerated a localhost `ws:`; the provider never
 *     enables it, so this case stays off the nominal path).
 *
 * `validation.url` comes from `URL.href`: port and path are already normalized
 * and preserved as-is, v86 requires no further tweaking.
 */
function toWispRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^wss:/i, 'wisps:').replace(/^ws:/i, 'wisp:');
}

/**
 * Builds the v86 network card matching a LumiBoot profile.
 *
 * The `type` field (NIC) is not set here: it comes from the HARDWARE PROFILE of
 * the catalog and is merged by the provider via
 * {@link toV86NetworkDeviceType}.
 *
 * @throws NetworkError `NETWORK_INVALID_RELAY_URL` in `user-relay` mode without
 *   a valid `wss://` address, `NETWORK_INVALID_PROXY_URL` in `local-proxy` mode
 *   without a valid loopback address, `NETWORK_UNSUPPORTED_MODE` in
 *   `local-network` mode.
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

/**
 * Translates the network card of the HARDWARE PROFILE
 * (`HardwareProfile.network`) into the type expected by v86
 * (`net_device.type`).
 *
 * Audit fix #18: the provider no longer decides the card by `id`/family or by a
 * `family`+`architecture` heuristic; it only READS the catalog contract and
 * translates it. `none` means "no card".
 *
 * `undefined` (hardware profile absent) falls back to the documented default
 * `'virtio'`.
 */
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
 * Wires the network traffic counters to the real v86 events.
 *
 * v86 publishes TWO notifications for each outgoing frame: `net0-send` (raw
 * frame emitted by the card) then `eth-transmit-end` (end of transmission, with
 * the byte count). Counting both would double the traffic: `net0-send` is
 * preferred and `eth-transmit-end` only serves as a fallback as long as no
 * `net0-send` frame has been observed. `eth-receive-end` feeds the reception.
 *
 * @returns a detach function (removes the three listeners).
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
