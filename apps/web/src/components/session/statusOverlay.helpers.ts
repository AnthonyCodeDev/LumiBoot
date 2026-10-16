import type { SessionSnapshot } from '@lumiboot/vm-core';

export interface StatusMessage {
  title: string;
  detail?: string;
}

/**
 * Message sobre pour les états hors démarrage (arrêt, inactivité).
 * Ces états n'affichent ni journal ni progression.
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

export function statusTextForSession(session: SessionSnapshot): string {
  switch (session.state) {
    case 'downloading':
      return 'Chargement des ressources…';
    case 'booting':
      return 'Démarrage du système…';
    case 'running':
      return 'Session active.';
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
