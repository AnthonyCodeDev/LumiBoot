import type { OSDefinition } from '@lumiboot/contracts';
import { isEngineIntegrated } from './compatibility';
import { getPrimaryLaunchProfile } from './labels';

export interface LaunchReadiness {
  canLaunch: boolean;
  reason?: string;
}

/**
 * Source de vérité pour l'activation du bouton « Lancer une session ».
 *
 * Un système n'est lançable que si son moteur principal est intégré ET que
 * son entrée catalogue est marquée `availability: 'ready'`.
 */
export function getLaunchReadiness(system: OSDefinition): LaunchReadiness {
  if (system.availability !== 'ready') {
    return {
      canLaunch: false,
      reason:
        'Ce système est en préparation : son moteur et son image ne sont pas encore disponibles.',
    };
  }
  const profile = getPrimaryLaunchProfile(system);
  if (!isEngineIntegrated(profile.engineId)) {
    return {
      canLaunch: false,
      reason: `Le moteur « ${profile.engineId} » n'est pas encore intégré.`,
    };
  }
  return { canLaunch: true };
}
