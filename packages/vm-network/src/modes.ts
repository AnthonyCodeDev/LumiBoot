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
  /** Any profile change requires a new session: no hot switching. */
  requiresRestart: boolean;
  requiresConfiguration: boolean;
}

export const networkModes: Record<NetworkMode, NetworkModeInfo> = {
  offline: {
    id: 'offline',
    label: 'Offline',
    description: 'No network access: the guest machine is fully isolated.',
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: false,
  },
  'browser-fetch': {
    id: 'browser-fetch',
    label: 'Browser network',
    description:
      'Network emulated on top of the browser fetch API. Subject to CORS constraints and ' +
      'without full Internet access.',
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: false,
  },
  'local-proxy': {
    id: 'local-proxy',
    label: 'Local network proxy',
    description:
      'Internet through the locally installed LumiBoot Network Proxy: TCP connections go out ' +
      "over the user's real connection (local WISP on 127.0.0.1).",
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: true,
  },
  'user-relay': {
    id: 'user-relay',
    label: 'Personal relay (WISP)',
    description:
      'Internet through a personal WISP server supplied and administered by the user; ' +
      'full access is never guaranteed by default.',
    availability: 'ready',
    requiresRestart: true,
    requiresConfiguration: true,
  },
  'local-network': {
    id: 'local-network',
    label: 'Local network',
    description:
      'Virtual network between browser guests (shared local segment), not access to the ' +
      "host's physical LAN. This feature is not implemented.",
    availability: 'planned',
    requiresRestart: true,
    requiresConfiguration: true,
  },
};
