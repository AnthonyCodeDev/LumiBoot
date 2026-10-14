import type { SessionSnapshot } from '@lumiboot/vm-core';

export const STEPS = [
  'Préparation',
  'Téléchargement',
  'Démarrage du noyau Debian',
  'Système prêt',
] as const;

export interface StatusMessage {
  title: string;
  detail?: string;
}

/**
 * Message sobre pour les états hors progression (arrêt, inactivité).
 * Ces états n'affichent ni timeline ni barre de progression.
 */
export function statusMessageForSession(session: SessionSnapshot): StatusMessage {
  switch (session.state) {
    case 'stopping':
      return { title: 'Arrêt en cours…', detail: 'La session est en cours de fermeture.' };
    case 'stopped':
      return { title: 'Système arrêté', detail: 'La session a été arrêtée.' };
    case 'idle':
    default:
      return { title: 'Session inactive', detail: 'Aucune session en cours.' };
  }
}

export function stepIndexForState(state: SessionSnapshot['state']): number {
  switch (state) {
    case 'preparing':
      return 0;
    case 'downloading':
      return 1;
    case 'booting':
      return 2;
    case 'running':
      return 3;
    default:
      return -1;
  }
}

export function statusTextForSession(session: SessionSnapshot): string {
  switch (session.state) {
    case 'downloading':
      return 'Téléchargement des ressources…';
    case 'booting':
      return 'Démarrage du noyau Debian…';
    case 'running':
      return 'Système prêt.';
    case 'stopped':
      return 'Session arrêtée.';
    case 'stopping':
      return 'Arrêt de la session…';
    case 'preparing':
    case 'idle':
    default:
      return 'Préparation de la session…';
  }
}

export function formatSessionBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} o`;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 100 ? Math.round(size).toString() : size.toFixed(1).replace('.', ',');
  return `${rounded} ${units[unitIndex]}`;
}
