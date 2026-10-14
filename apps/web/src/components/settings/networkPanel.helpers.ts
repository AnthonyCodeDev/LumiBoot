import {
  capabilitiesForMode,
  networkModes,
  type NetworkCapabilities,
  type NetworkMode,
  type NetworkStatus,
} from '@lumiboot/vm-network';
import type { SessionSnapshot } from '@lumiboot/vm-core';

export interface NetworkModeOption {
  id: NetworkMode;
  label: string;
  description: string;
  /** Mode non finalisé : affiché mais non sélectionnable. */
  planned: boolean;
}

/** Ordre d'affichage des modes ; `local-network` reste désactivé (« bientôt »). */
const MODE_ORDER: readonly NetworkMode[] = [
  'offline',
  'browser-fetch',
  'user-relay',
  'local-network',
];

export const NETWORK_MODE_OPTIONS: readonly NetworkModeOption[] = MODE_ORDER.map((id) => {
  const info = networkModes[id];
  return {
    id,
    label: info.label,
    description: info.description,
    planned: info.availability !== 'ready',
  };
});

/**
 * Avertissement honnête pour le mode `browser-fetch` : on ne prétend jamais à
 * un accès Internet complet. Affiché tel quel à l'écran.
 */
export const BROWSER_FETCH_NOTICE =
  'HTTP(S) via fetch du navigateur — soumis aux restrictions CORS ; Internet complet NON garanti.';

const CAPABILITY_LABELS: ReadonlyArray<readonly [keyof NetworkCapabilities, string]> = [
  ['ethernet', 'Interface Ethernet'],
  ['ip', 'Adressage IP'],
  ['sockets', 'Sockets'],
  ['dhcp', 'DHCP'],
  ['dns', 'DNS'],
  ['tcp', 'TCP'],
  ['udp', 'UDP'],
  ['icmp', 'ICMP (ping)'],
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
];

export interface CapabilityRow {
  label: string;
  enabled: boolean;
}

/**
 * Construit la liste des capacités affichées. La ligne « Internet complet »
 * n'apparaît **que** si `fullInternet === true` : on ne l'affiche jamais à tort.
 */
export function buildCapabilityRows(capabilities: NetworkCapabilities): CapabilityRow[] {
  const rows = CAPABILITY_LABELS.map(([key, label]) => ({ label, enabled: capabilities[key] }));
  if (capabilities.fullInternet) {
    rows.push({ label: 'Internet complet', enabled: true });
  }
  return rows;
}

export function capabilitiesFor(mode: NetworkMode): NetworkCapabilities {
  return capabilitiesForMode(mode);
}

const STATUS_LABELS: Record<NetworkStatus, string> = {
  idle: 'Inactif',
  starting: 'Démarrage…',
  connected: 'Connecté',
  offline: 'Hors ligne',
  error: 'Erreur',
  stopped: 'Arrêté',
};

export function networkStatusLabel(status: NetworkStatus): string {
  return STATUS_LABELS[status];
}

export function networkModeLabel(mode: NetworkMode): string {
  return networkModes[mode].label;
}

/**
 * Sélectionne les diagnostics réseau de la première session qui en expose.
 * Une session sans `network` (ou arrêtée) n'apparaît pas.
 */
export function pickActiveNetworkDiagnostics(
  sessions: Record<string, SessionSnapshot>,
): NonNullable<SessionSnapshot['network']> | undefined {
  for (const session of Object.values(sessions)) {
    if (session.network) return session.network;
  }
  return undefined;
}
