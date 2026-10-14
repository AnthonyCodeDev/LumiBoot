/**
 * Modes réseau proposés par LumiBoot. Chaque mode décrit *comment* une machine
 * virtuelle accède (ou non) au réseau, indépendamment du moteur d'exécution et
 * du système invité.
 */

export const NETWORK_MODES = ['offline', 'browser-fetch', 'user-relay', 'local-network'] as const;

export type NetworkMode = (typeof NETWORK_MODES)[number];

export interface NetworkModeInfo {
  id: NetworkMode;
  label: string;
  description: string;
  availability: 'ready' | 'planned';
  requiresRestart: boolean;
  requiresConfiguration: boolean;
}

export const networkModes: Record<NetworkMode, NetworkModeInfo> = {
  offline: {
    id: 'offline',
    label: 'Hors ligne',
    description: 'Aucun accès réseau : la machine invitée est totalement isolée.',
    availability: 'ready',
    requiresRestart: false,
    requiresConfiguration: false,
  },
  'browser-fetch': {
    id: 'browser-fetch',
    label: 'Réseau du navigateur',
    description:
      'Réseau émulé au-dessus de fetch du navigateur. Soumis aux contraintes CORS et ' +
      "sans accès Internet complet.",
    availability: 'ready',
    requiresRestart: false,
    requiresConfiguration: false,
  },
  'user-relay': {
    id: 'user-relay',
    label: 'Relais personnel (WISP)',
    description:
      "Accès Internet complet via un serveur WISP fourni et administré par l'utilisateur.",
    availability: 'ready',
    requiresRestart: false,
    requiresConfiguration: true,
  },
  'local-network': {
    id: 'local-network',
    label: 'Réseau local',
    description: "Accès au réseau local de la machine hôte. Fonctionnalité non implémentée.",
    availability: 'planned',
    requiresRestart: true,
    requiresConfiguration: true,
  },
};
