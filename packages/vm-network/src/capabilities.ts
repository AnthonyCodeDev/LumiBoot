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
 *
 * Distinction fondamentale (ne jamais la confondre) :
 *
 * - **Capacité de transport** : statique, décrit ce que le mode *peut* faire
 *   d'après le matériel émulé, la pile invitée et le backend. C'est une
 *   intention, pas une preuve.
 * - **Fonctionnalité vérifiée** : runtime, jamais garantie par le mode. Elle
 *   n'est établie qu'après une **sonde réelle** réussie (`tcp`/`https`) et se
 *   matérialise par `fullInternet`/`verified`, tous deux `false` par défaut.
 *
 * Autrement dit : annoncer `https: true` décrit une capacité de transport ;
 * cela ne prouve **pas** qu'une requête HTTPS aboutira réellement.
 */
export interface NetworkCapabilities {
  nic: NicCapabilities;
  guestStack: GuestStackCapabilities;
  transport: TransportCapabilities;
  /**
   * Accès Internet **complet et vérifié** (`tcp`/`udp`/`icmp` arbitraires).
   * Reste `false` par défaut et n'est jamais déduit du mode : il ne peut devenir
   * vrai qu'après vérification réelle à l'exécution (sonde).
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
 * Réseau émulé au-dessus du `fetch` natif de v86.
 *
 * État **factuel** du backend `browser-fetch` de v86 0.5.471 : l'invité obtient
 * DHCP/DNS et atteint Internet en **HTTP (port 80)** ; le backend n'enregistre
 * le TCP que pour le port 80, donc **HTTPS (443) échoue**. Les hôtes sans
 * en-tête CORS sont de plus bloqués (`cors = true`).
 *
 * `transport.https` est donc `false` : annoncer `https: true` serait **faux**.
 * `guestStack.tcp` reste `true` mais **limité au transport HTTP** (port 80).
 * UDP/ICMP ne sont **pas** disponibles et `fullInternet` n'est **pas** garanti.
 */
export const BROWSER_FETCH_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true, // limité au port 80 : le backend ne transport que HTTP.
    udp: false,
    icmp: false,
  }),
  transport: Object.freeze({ kind: 'fetch', http: true, https: false, cors: true }),
  fullInternet: false,
});

/**
 * Relais WISP **personnel** de l'utilisateur (`wss://`).
 *
 * Un **vrai relais WISP** peut transporter du TCP arbitraire, y compris le
 * **443**, donc `transport.https = true` est une capacité de transport légitime.
 * `cors = false` car le relais relaie des trames et n'est **pas** soumis à CORS.
 *
 * Mais cette capacité reste **statique** : elle ne prouve rien à l'exécution.
 * `udp` est **optionnel/relais-dépendant** et `icmp` **non garanti** — les deux
 * restent donc `false` par défaut. `fullInternet` est **jamais** accordé par la
 * simple sélection du mode : seul le runtime (sonde) peut le confirmer.
 */
export const USER_RELAY_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // optionnel / dépend du relais.
    icmp: false, // non garanti.
  }),
  transport: Object.freeze({ kind: 'wisp', http: true, https: true, cors: false }),
  fullInternet: false,
});

/**
 * Relais WISP **local géré par le compagnon** (loopback, `ws://127.0.0.1:37892/wisp/`).
 *
 * Comme `user-relay`, le transport WISP peut porter du TCP arbitraire (dont le
 * 443), donc `transport.https = true` est une capacité de transport légitime et
 * `cors = false` (trames relayées, pas de contrainte CORS navigateur).
 *
 * Mais cette capacité reste **statique** et ne garantit rien tant que la
 * connectivité n'est pas prouvée par sonde : `udp`/`icmp` restent `false` et
 * `fullInternet` ne peut devenir vrai qu'après vérification réelle à
 * l'exécution.
 */
export const LOCAL_COMPANION_CAPABILITIES: NetworkCapabilities = Object.freeze({
  nic: Object.freeze({ ethernet: true, virtio: true, ne2k: true }),
  guestStack: Object.freeze({
    ip: true,
    dhcp: true,
    dns: true,
    tcp: true,
    udp: false, // optionnel / dépend du relais.
    icmp: false, // non garanti.
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
    case 'local-companion':
      return LOCAL_COMPANION_CAPABILITIES;
    case 'local-network':
      return LOCAL_NETWORK_CAPABILITIES;
  }
}
