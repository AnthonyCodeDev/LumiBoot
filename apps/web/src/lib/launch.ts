import type { OSDefinition } from '@lumiboot/contracts';
import { isEngineIntegrated } from './compatibility';
import { getPrimaryLaunchProfile } from './labels';

export interface LaunchReadiness {
  canLaunch: boolean;
  reason?: string;
}

export interface LaunchReadinessOptions {
  /**
   * Le média local requis par un système `user-import` a-t-il réellement été
   * importé (octets disponibles) ? Fourni par le store de médias utilisateur.
   */
  userMediaReady?: boolean;
}

/**
 * Source de vérité pour l'activation du bouton « Lancer une session ».
 *
 * - Système à **disque local** (`readiness.mode === 'disk-boot'`, ex. Windows 7) :
 *   lançable directement dès que le moteur est intégré et qu'un disque est
 *   référencé (`imageRef`). Aucun média n'est importé ni demandé : le disque est
 *   celui de la codebase, servi localement.
 * - Système `bundled` : lançable si le moteur principal est intégré ET que
 *   l'entrée catalogue est `ready` (boot réel validé).
 * - Système `user-import` : lançable dès que l'utilisateur a importé SON média
 *   légal — jamais auparavant.
 */
export function getLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions = {},
): LaunchReadiness {
  if (system.availability === 'unavailable') {
    return { canLaunch: false, reason: 'Ce système est marqué comme indisponible.' };
  }

  const profile = getPrimaryLaunchProfile(system);

  if (profile.readiness?.mode === 'disk-boot') {
    if (!isEngineIntegrated(profile.engineId)) {
      return {
        canLaunch: false,
        reason: `Le moteur « ${profile.engineId} » n'est pas encore intégré.`,
      };
    }
    if (!system.imageRef) {
      return {
        canLaunch: false,
        reason: 'Aucun disque local n’est associé à ce système.',
      };
    }
    return { canLaunch: true };
  }

  if (system.mediaStrategy === 'user-import') {
    if (!isEngineIntegrated(profile.engineId)) {
      return {
        canLaunch: false,
        reason: `Le moteur « ${profile.engineId} » n'est pas encore intégré.`,
      };
    }
    if (!options.userMediaReady) {
      return {
        canLaunch: false,
        reason:
          'Ressource requise : importez un média disque que vous détenez légalement pour ' +
          'démarrer cette session. Aucune image n’est distribuée par LumiBoot.',
      };
    }
    return { canLaunch: true };
  }

  if (system.availability !== 'ready') {
    return {
      canLaunch: false,
      reason:
        'Ce système est en préparation : son moteur et son image ne sont pas encore disponibles.',
    };
  }
  if (!isEngineIntegrated(profile.engineId)) {
    return {
      canLaunch: false,
      reason: `Le moteur « ${profile.engineId} » n'est pas encore intégré.`,
    };
  }
  return { canLaunch: true };
}
