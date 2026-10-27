import type { NetworkMode } from './modes';

/** Internet access transport backend. */
export type NetworkTransportKind = 'none' | 'fetch' | 'wisp';

/** Emulated NIC, independent of the transport and of the guest stack. */
export interface NicCapabilities {
  ethernet: boolean;
  virtio: boolean;
  ne2k: boolean;
}

/** What the guest OS can do on top of the NIC, independent of the transport. */
export interface GuestStackCapabilities {
  ip: boolean;
  dhcp: boolean;
  dns: boolean;
  tcp: boolean;
  udp: boolean;
  icmp: boolean;
}

/** `cors` means the transport is subject to CORS. */
export interface TransportCapabilities {
  kind: NetworkTransportKind;
  http: boolean;
  https: boolean;
  cors: boolean;
}

/** Static capability, not a proof that a request will succeed. */
export interface NetworkCapabilities {
  nic: NicCapabilities;
  guestStack: GuestStackCapabilities;
  transport: TransportCapabilities;
  /** Only a successful runtime probe may set it to true. */
  fullInternet: boolean;
}

const NO_NIC: NicCapabilities = Object.freeze({
  ethernet: false,
  virtio: false,
  ne2k: false,
});

const NO_GUEST_STACK: GuestStackCapabilities = Object.freeze({
  ip: false,
  dhcp: false,
  dns: false,
  tcp: false,
  udp: false,
  icmp: false,
});

const NO_TRANSPORT: TransportCapabilities = Object.freeze({
  kind: 'none',
  http: false,
  https: false,
  cors: false,
});

/** No network access. */
export const OFFLINE_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: NO_NIC,
  guestStack: NO_GUEST_STACK,
  transport: NO_TRANSPORT,
  fullInternet: false,
});

/**
 * The v86 `fetch` backend only carries HTTP port 80, so HTTPS fails and
 * `transport.https` stays false.
 */
export const BROWSER_FETCH_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true, // port 80 only.
    udp: false,
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'fetch', http: true, https: false, cors: true }),
  fullInternet: false,
});

/**
 * A real WISP relay carries arbitrary TCP including 443, but this stays a static
 * capability: only a probe can confirm connectivity.
 */
export const USER_RELAY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // depends on the relay.
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/** Same capabilities as `user-relay`, on a loopback WISP relay. */
export const LOCAL_PROXY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // depends on the relay.
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/** Not implemented: it would be a virtual segment between guests, not the LAN. */
export const LOCAL_NETWORK_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: NO_NIC,
  guestStack: NO_GUEST_STACK,
  transport: NO_TRANSPORT,
  fullInternet: false,
});

export function capabilitiesForMode(mode: NetworkMode): NetworkCapabilities {
  switch (mode) {
    case 'offline':
      return OFFLINE_CAPABILITIES;
    case 'browser-fetch':
      return BROWSER_FETCH_CAPABILITIES;
    case 'user-relay':
      return USER_RELAY_CAPABILITIES;
    case 'local-proxy':
      return LOCAL_PROXY_CAPABILITIES;
    case 'local-network':
      return LOCAL_NETWORK_CAPABILITIES;
  }
}
