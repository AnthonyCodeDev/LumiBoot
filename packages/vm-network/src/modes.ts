/**
 * Modes réseau proposés par LumiBoot. Chaque mode décrit *comment* une machine
 * virtuelle accède (ou non) au réseau, indépendamment du moteur d'exécution et
 * du système invité.
 */

export const NETWORK_MODES = [
  'offline',
  'browser-fetch',
  'local-proxy',
  'user-relay',
  'local-network',
] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

export interface NetworkModeInfo {
  id: NetworkMode;
  label: string;
  description: string;
  availability: 'ready' | 'planned';
  /**
   * Toujours `true` : le profil réseau v86 est fixé **avant** la construction de
   * l'émulateur (traduction vers `net_device`). Tout changement de profil
   * réseau — y compris vers/depuis `offline` — exige donc une **nouvelle
   * session** ; aucun basculement à chaud n'est supporté.
   */
  requiresRestart: boolean;
  requiresConfiguration: boolean;
}

export const networkModes: Record<NetworkMode, NetworkModeInfo> = {
  offline: {
    id: 'offline',
    label: 'Hors ligne',
    description: 'Aucun accès réseau : la machine invitée est totalement isolée.',
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: false,
  },
  'browser-fetch': {
    id: 'browser-fetch',
    label: 'Réseau du navigateur',
    description:
      'Réseau émulé au-dessus de fetch du navigateur. Soumis aux contraintes CORS et ' +
      'sans accès Internet complet.',
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: false,
  },
  'local-proxy': {
    id: 'local-proxy',
    label: 'Proxy réseau local',
    description:
      "Internet via le LumiBoot Network Proxy installé localement : les connexions TCP sortent par la vraie connexion de l'utilisateur (WISP local sur 127.0.0.1).",
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: true,
  },
  'user-relay': {
    id: 'user-relay',
    label: 'Relais personnel (WISP)',
    description:
      "Internet via un serveur WISP personnel fourni et administré par l'utilisateur ; " +
      "l'accès complet n'est jamais garanti par défaut.",
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: true,
  },
  'local-network': {
    id: 'local-network',
    label: 'Réseau local',
    description:
      'Réseau virtuel entre invités du navigateur (segment local partagé), et non un accès ' +
      "au réseau LAN physique de l'hôte. Fonctionnalité non implémentée.",
    availability: 'planned',
    requiresRestart: true,
    requiresConfiguration: true,
  },
};
