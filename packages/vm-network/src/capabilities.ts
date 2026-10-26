import type { NetworkMode } from './modes';

/** Internet access transport backend. */
export type NetworkTransportKind = 'none' | 'fetch' | 'wisp';

/**
 * Virtual network card (NIC) offered to the guest machine. Describes the
 * **emulated network hardware**, independently of the transport and of the
 * guest stack.
 */
export interface NicCapabilities {
  ethernet: boolean;
  virtio: boolean;
  ne2k: boolean;
}

/**
 * **Guest** TCP/IP stack: what the VM operating system can really do on top of
 * the NIC. Independent of the transport backend.
 */
export interface GuestStackCapabilities {
  ip: boolean;
  dhcp: boolean;
  dns: boolean;
  tcp: boolean;
  udp: boolean;
  icmp: boolean;
}

/**
 * Internet access transport backend. `kind` designates the real mechanism;
 * `cors = true` means requests are **subject to CORS** (browser constraint);
 * `cors = false` means no browser CORS constraint applies to the transport used
 * (never the opposite of a CORS proxy).
 */
export interface TransportCapabilities {
  kind: NetworkTransportKind;
  http: boolean;
  https: boolean;
  cors: boolean;
}

/**
 * Network capabilities of a mode. Four **distinct** levels are separated to
 * avoid any misleading promise: NIC, guest TCP/IP stack, transport backend, and
 * really verified Internet connectivity.
 *
 * Fundamental distinction (never confuse it):
 *
 * - **Transport capability**: static, describes what the mode *can* do based on
 *   the emulated hardware, the guest stack and the backend. It is an intention,
 *   not a proof.
 * - **Verified feature**: runtime, never guaranteed by the mode. It is only
 *   established after a successful **real probe** (`tcp`/`https`) and
 *   materializes as `fullInternet`/`verified`, both `false` by default.
 *
 * In other words: announcing `https: true` describes a transport capability; it
 * does **not** prove that an HTTPS request will really succeed.
 */
export interface NetworkCapabilities {
  nic: NicCapabilities;
  guestStack: GuestStackCapabilities;
  transport: TransportCapabilities;
  /**
   * **Full and verified** Internet access (arbitrary `tcp`/`udp`/`icmp`). Stays
   * `false` by default and is never inferred from the mode: it can only become
   * true after a real runtime check (probe).
   */
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

/** No network access: no level is available. */
export const OFFLINE_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: NO_NIC,
  guestStack: NO_GUEST_STACK,
  transport: NO_TRANSPORT,
  fullInternet: false,
});

/**
 * Network emulated on top of the native v86 `fetch`.
 *
 * **Factual** state of the `browser-fetch` backend of v86 0.5.471: the guest
 * gets DHCP/DNS and reaches the Internet over **HTTP (port 80)**; the backend
 * only registers TCP for port 80, so **HTTPS (443) fails**. Hosts without a CORS
 * header are additionally blocked (`cors = true`).
 *
 * `transport.https` is therefore `false`: announcing `https: true` would be
 * **false**. `guestStack.tcp` stays `true` but **limited to the HTTP transport**
 * (port 80). UDP/ICMP are **not** available and `fullInternet` is **not**
 * guaranteed.
 */
export const BROWSER_FETCH_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true, // limited to port 80: the backend only carries HTTP.
    udp: false,
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'fetch', http: true, https: false, cors: true }),
  fullInternet: false,
});

/**
 * **Personal** WISP relay of the user (`wss://`).
 *
 * A **real WISP relay** can carry arbitrary TCP, including **443**, so
 * `transport.https = true` is a legitimate transport capability. `cors = false`
 * because the relay forwards frames and is **not** subject to CORS.
 *
 * But this capability stays **static**: it proves nothing at runtime. `udp` is
 * **optional/relay-dependent** and `icmp` **not guaranteed** — both therefore
 * stay `false` by default. `fullInternet` is **never** granted by simply
 * selecting the mode: only the runtime (probe) can confirm it.
 */
export const USER_RELAY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // optional / depends on the relay.
    icmp: false, // not guaranteed.
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/**
 * WISP relay **local to and managed by the local network proxy** (loopback,
 * `ws://127.0.0.1:37892/wisp/`).
 *
 * Like `user-relay`, the WISP transport can carry arbitrary TCP (including 443),
 * so `transport.https = true` is a legitimate transport capability and
 * `cors = false` (forwarded frames, no browser CORS constraint).
 *
 * But this capability stays **static** and guarantees nothing until connectivity
 * is proven by a probe: `udp`/`icmp` stay `false` and `fullInternet` can only
 * become true after a real runtime check.
 */
export const LOCAL_PROXY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // optional / depends on the relay.
    icmp: false, // not guaranteed.
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/**
 * `local-network` mode: **unavailable** as long as it is not implemented.
 * It designates a **virtual network between guests** (shared local
 * segment), **not** an access to the host's physical LAN. No capability is
 * announced as long as the virtual switch does not exist.
 */
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
