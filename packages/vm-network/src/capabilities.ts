import type { NetworkMode } from './modes';

/** Capacités réseau théoriques offertes à la machine invitée selon le mode. */
export interface NetworkCapabilities {
  ethernet: boolean;
  ip: boolean;
  sockets: boolean;
  dhcp: boolean;
  dns: boolean;
  tcp: boolean;
  udp: boolean;
  icmp: boolean;
  http: boolean;
  https: boolean;
  cors: boolean;
  fullInternet: boolean;
}

/** Aucun accès réseau : toutes les capacités sont désactivées. */
export const OFFLINE_CAPABILITIES: NetworkCapabilities = Object.freeze({
  ethernet: false,
  ip: false,
  sockets: false,
  dhcp: false,
  dns: false,
  tcp: false,
  udp: false,
  icmp: false,
  http: false,
  https: false,
  cors: false,
  fullInternet: false,
});

/**
 * Réseau émulé au-dessus de fetch : HTTP(S) fonctionne mais reste soumis aux
 * contraintes CORS du navigateur, sans accès Internet complet.
 */
export const BROWSER_FETCH_CAPABILITIES: NetworkCapabilities = Object.freeze({
  ethernet: false,
  ip: false,
  sockets: false,
  dhcp: true,
  dns: true,
  tcp: true,
  udp: true,
  icmp: false,
  http: true,
  https: true,
  cors: true,
  fullInternet: false,
});

/** Relais WISP personnel : accès Internet complet, sans contrainte CORS. */
export const USER_RELAY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  ethernet: true,
  ip: true,
  sockets: true,
  dhcp: true,
  dns: true,
  tcp: true,
  udp: true,
  icmp: true,
  http: true,
  https: true,
  cors: false,
  fullInternet: true,
});

/** Réseau local (futur) : accès au réseau de l'hôte, sans Internet complet externe. */
export const LOCAL_NETWORK_CAPABILITIES: NetworkCapabilities = Object.freeze({
  ethernet: true,
  ip: true,
  sockets: true,
  dhcp: true,
  dns: true,
  tcp: true,
  udp: true,
  icmp: true,
  http: true,
  https: true,
  cors: false,
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
