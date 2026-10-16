import type { LaunchProfile, OSDefinition } from '@lumiboot/contracts';
import {
  checkImageAvailability,
  checkLocalDiskAvailability,
  type AssetAvailabilityOptions,
  type AssetUnavailableReason,
} from '@lumiboot/vm-assets';
import { getDeclaredReadiness } from '@lumiboot/catalog';
import { isEngineIntegrated } from './compatibility';
import { getPrimaryLaunchProfile } from './labels';
import { explainSystemCompatibility } from '../features/sessions/registry';

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
 * Message utilisateur stable par cause d'indisponibilité runtime. On ne
 * présente jamais un motif technique brut : chaque cause (404, repli HTML d'une
 * SPA, absence de HTTP Range…) a une explication actionnable.
 */
const RUNTIME_REASON_MESSAGES: Record<AssetUnavailableReason, string> = {
  'ref-invalid': 'La référence du média système est invalide.',
  'manifest-missing': 'Le manifeste du média est absent du serveur (HTTP 404).',
  'manifest-html':
    'Le serveur a renvoyé une page HTML (repli SPA) au lieu du manifeste JSON du média.',
  'manifest-invalid': 'Le manifeste du média n’est pas un JSON lisible.',
  'manifest-schema': 'Le manifeste du média ne respecte pas le schéma attendu.',
  'ref-mismatch': 'La référence du manifeste ne correspond pas au système demandé.',
  'disk-missing': 'Le disque du média est absent du serveur (HTTP 404).',
  'disk-html': 'Le serveur a renvoyé une page HTML (repli SPA) au lieu du fichier disque.',
  'disk-mismatch': 'La taille du disque servi ne correspond pas à celle annoncée par le manifeste.',
  'range-unsupported':
    'Le serveur ne sert pas le disque en HTTP Range (206) : v86 ne peut pas le lire par plages.',
  unauthorized: 'L’accès au média a été refusé par le serveur.',
  network: 'Le média est inaccessible (erreur réseau).',
  aborted: 'La vérification de disponibilité du média a été annulée.',
};

/**
 * Source de vérité pour l'activation du bouton « Lancer une session », côté
 * DÉCLARÉ (catalogue) et contraintes statiques.
 *
 * - Système à **disque local** (`readiness.mode === 'disk-boot'`, ex. Windows 7) :
 *   lançable dès que le moteur est intégré, qu'un disque est référencé
 *   (`imageRef`), que la mémoire allouée est cohérente et que l'architecture est
 *   servie par le moteur. Aucun média n'est importé ni demandé : le disque est
 *   celui de la codebase, servi localement. Sa présence réelle est vérifiée au
 *   runtime par `checkSystemRuntimeAvailability`.
 * - Système `bundled` : lançable si l'entrée catalogue est `ready`, que le
 *   moteur principal est intégré et que l'architecture est servie.
 * - Système `user-import` : lançable dès que l'utilisateur a importé SON média
 *   légal — jamais auparavant.
 *
 * L'architecture non servie (ex. `x86_64`/`arm64` sous v86) et l'absence de
 * moteur intégré sont refusées EXPLICITEMENT ici, avant tout démarrage.
 */
export function getLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions = {},
): LaunchReadiness {
  if (system.availability === 'unavailable') {
    return { canLaunch: false, reason: 'Ce système est marqué comme indisponible.' };
  }

  const profile = getPrimaryLaunchProfile(system);
  const declared = getDeclaredReadiness(system);

  // 1. Contrôles liés à la source du média.
  if (declared.mediaSource === 'user-import') {
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
  } else if (declared.mediaSource === 'local-disk') {
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
  } else {
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
  }

  // 2. Contrainte mémoire déclarée (cohérence profil / mémoire allouée).
  const memoryReason = getMemoryConstraintReason(system, profile);
  if (memoryReason !== null) return { canLaunch: false, reason: memoryReason };

  // 3. Compatibilité runtime architecture/CPU + prérequis navigateur. Un moteur
  //    qui ne sert pas l'architecture du système est refusé ici, pas au démarrage.
  const compatibility = explainSystemCompatibility(system);
  if (!compatibility.compatible) {
    return { canLaunch: false, reason: compatibility.reasons.join(' ') };
  }

  return { canLaunch: true };
}

/**
 * Contrainte mémoire statique : la mémoire configurée doit être définie et au
 * moins égale au minimum déclaré par le profil. Les deux valeurs viennent du
 * catalogue ; ce contrôle empêche un profil incohérent de promettre un boot
 * qu'il ne peut pas tenir.
 */
function getMemoryConstraintReason(system: OSDefinition, profile: LaunchProfile): string | null {
  const configured = profile.configuration?.memoryMiB ?? system.minMemoryMiB;
  if (configured === undefined || configured <= 0) {
    return 'Mémoire invitée non définie : le lancement ne peut pas être garanti.';
  }
  const minimum = profile.minMemoryMiB;
  if (minimum !== undefined && configured < minimum) {
    return `Mémoire invitée insuffisante : ${configured} Mio alloués pour ${minimum} Mio requis.`;
  }
  return null;
}

/** Options de la vérification de disponibilité runtime (injectables en test). */
export interface RuntimeCheckOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** Résultat d'une vérification de disponibilité runtime du média. */
export interface RuntimeAvailability {
  readonly available: boolean;
  readonly reason?: string;
  /** Taille du disque annoncée par le serveur (`Content-Range`), si connue. */
  readonly size?: number;
}

/**
 * Vérifie que le média DÉCLARÉ d'un système est réellement servable maintenant :
 * manifeste JSON valide, référence cohérente et disque servi en HTTP Range
 * (206 + `Content-Range`). Séparé de la disponibilité catalogue : un `ready`
 * déclaré peut très bien correspondre à un disque absent (gitignoré), à un repli
 * HTML de SPA ou à un serveur qui ignore Range.
 *
 * Pour un système `user-import`, le média est local (blob du navigateur) : il
 * n'est jamais vérifié par HTTP — seule la présence importée (`userMediaReady`)
 * compte, contrôlée par l'appelant.
 */
export async function checkSystemRuntimeAvailability(
  system: OSDefinition,
  options: RuntimeCheckOptions = {},
): Promise<RuntimeAvailability> {
  const declared = getDeclaredReadiness(system);
  if (declared.mediaSource === 'user-import') return { available: true };

  const ref = system.imageRef;
  if (!ref) {
    return { available: false, reason: 'Aucun média n’est associé à ce système.' };
  }

  const assetOptions: AssetAvailabilityOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  const result =
    declared.mediaSource === 'local-disk'
      ? await checkLocalDiskAvailability(ref, assetOptions)
      : await checkImageAvailability(ref, assetOptions);

  if (result.available) {
    return { available: true, ...(result.size === undefined ? {} : { size: result.size }) };
  }
  const reason =
    result.message ??
    RUNTIME_REASON_MESSAGES[result.reason ?? 'network'] ??
    'Le média système est indisponible.';
  return { available: false, reason };
}

/**
 * Readiness COMPLÈTE du bouton de lancement : d'abord les contraintes déclarées
 * (catalogue, moteur, architecture, mémoire, média importé), puis la
 * disponibilité runtime (manifeste + disque HTTP Range). Renvoie la première
 * raison de refus explicite.
 */
export async function resolveLaunchReadiness(
  system: OSDefinition,
  options: LaunchReadinessOptions & RuntimeCheckOptions = {},
): Promise<LaunchReadiness> {
  const declared = getLaunchReadiness(system, {
    ...(options.userMediaReady === undefined ? {} : { userMediaReady: options.userMediaReady }),
  });
  if (!declared.canLaunch) return declared;

  const runtime = await checkSystemRuntimeAvailability(system, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  if (!runtime.available) {
    return {
      canLaunch: false,
      reason: runtime.reason ?? 'Le média système est indisponible.',
    };
  }
  return { canLaunch: true };
}
