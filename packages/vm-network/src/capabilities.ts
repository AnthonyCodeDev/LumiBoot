import type { NetworkMode } from './modes';

/** Backend de transport d'accès Internet. */
export type NetworkTransportKind = 'none' | 'fetch' | 'wisp';

/**
 * Carte réseau virtuelle (NIC) offerte à la machine invitée. Décrit le
 * **matériel réseau émulé**, indépendamment du transport et de la pile invitée.
 */
export interface NicCapabilities {
  ethernet: boolean;
  virtio: boolean;
  ne2k: boolean;
}

/**
 * Pile TCP/IP **invitée** : ce que le système d'exploitation de la VM peut
 * réellement faire au-dessus de la NIC. Indépendant du backend de transport.
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
 * Backend de transport d'accès Internet. `kind` désigne le mécanisme réel ;
 * `cors = true` signifie que les requêtes sont **soumises à CORS** (contrainte
 * navigateur) ; `cors = false` signifie qu'aucune contrainte CORS navigateur ne
 * s'applique au transport utilisé (jamais l'inverse d'un proxy CORS).
 */
export interface TransportCapabilities {
  kind: NetworkTransportKind;
  http: boolean;
  https: boolean;
  cors: boolean;
}

/**
 * Capacités réseau d'un mode. Quatre niveaux **distincts** sont séparés pour
 * éviter toute promesse mensongère : NIC, pile TCP/IP invitée, backend de
 * transport, et connectivité Internet réellement vérifiée.
 */
export interface NetworkCapabilities {
  nic: NicCapabilities;
  guestStack: GuestStackCapabilities;
  transport: TransportCapabilities;
  /**
   * Accès Internet **complet et vérifié** (`tcp`/`udp`/`icmp` arbitraires).
   * Reste `false` par défaut et n'est jamais déduit du mode : il ne peut devenir
   * vrai qu'après vérification à l'exécution.
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

/** Aucun accès réseau : aucun niveau n'est disponible. */
export const OFFLINE_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: NO_NIC,
  guestStack: NO_GUEST_STACK,
  transport: NO_TRANSPORT,
  fullInternet: false,
});

/**
 * Réseau émulé au-dessus du `fetch` natif de v86 : HTTP(S) fonctionne via le
 * navigateur mais reste **soumis à CORS**, sans accès réseau brut. UDP/ICMP ne
 * sont **pas** disponibles et Internet complet n'est **pas** garanti.
 */
export const BROWSER_FETCH_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false,
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'fetch', http: true, https: true, cors: true }),
  fullInternet: false,
});

/**
 * Relais WISP **personnel** de l'utilisateur (`wss://`). Ne **garantit pas**
 * Internet complet : `fullInternet` reste `false` par défaut. HTTP/HTTPS
 * dépendent du transport ; `cors = false` car le relais relaie des trames et
 * n'est pas soumis à CORS. UDP/ICMP ne sont **pas garantis** par défaut.
 */
export const USER_RELAY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false,
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/**
 * Mode `local-network` : **indisponible** tant qu'il n'est pas implémenté.
 * Il désignera un **réseau virtuel entre invités** (segment local partagé),
 * **pas** un accès au réseau LAN physique de l'hôte. Aucune capacité n'est
 * annoncée tant que le switch virtuel n'existe pas.
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
    case 'local-network':
      return LOCAL_NETWORK_CAPABILITIES;
  }
}
