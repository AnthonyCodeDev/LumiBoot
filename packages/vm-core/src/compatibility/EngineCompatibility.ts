import type { OSDefinition } from '@lumiboot/contracts';
import type { VMEngine } from '../contracts/VMEngine';

/**
 * Environnement de l'appareil/du déploiement, évalué avant un lancement.
 * Indépendant du catalogue : permet de tester la compatibilité sans dépendre
 * de l'UI ni d'une lecture globale du navigateur.
 */
export interface RuntimeEnvironment {
  webAssembly: boolean;
  crossOriginIsolated: boolean;
}

export interface EngineCompatibilityResult {
  compatible: boolean;
  reasons: string[];
}

/**
 * Détecte les prérequis navigateur à partir de `globalThis`, sans jamais toucher
 * au DOM : `vm-core` reste indépendant de l'interface et testable en Node. Sert
 * de valeur par défaut au registre, pour que l'UI n'ait pas à fournir
 * l'environnement d'exécution.
 */
export function detectRuntimeEnvironment(
  scope: typeof globalThis = globalThis,
): RuntimeEnvironment {
  const wasm = (scope as { WebAssembly?: typeof WebAssembly }).WebAssembly;
  return {
    webAssembly:
      typeof wasm === 'object' && wasm !== null && typeof wasm.instantiate === 'function',
    crossOriginIsolated: (scope as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  };
}

/**
 * Vérifie qu'un moteur peut réellement lancer un système sur l'appareil actuel.
 * Déterministe et sans effet de bord : aucune décision « implicite » n'est prise
 * ailleurs dans l'application.
 *
 * L'architecture (le CPU émulé) est comparée aux capacités DÉCLARÉES du moteur :
 * v86 ne déclare que `i386` et rejette donc `x86_64`/`arm64`. Un moteur qui ne
 * déclare aucune architecture (`architectures` vide) ne peut pas être contredit
 * sur ce critère — ses capacités ne sont simplement pas renseignées.
 */
export function checkEngineCompatibility(
  engine: VMEngine,
  os: OSDefinition,
  env: RuntimeEnvironment,
): EngineCompatibilityResult {
  const reasons: string[] = [];
  const capabilities = engine.capabilities();

  if (!engine.canRun(os)) {
    reasons.push(`Le moteur « ${engine.id} » ne prend pas en charge ${os.id}.`);
  }

  if (
    capabilities.architectures.length > 0 &&
    !capabilities.architectures.includes(os.architecture)
  ) {
    reasons.push(
      `Architecture ${os.architecture} non prise en charge par « ${engine.id} » ` +
        `(support déclaré : ${capabilities.architectures.join(', ')}).`,
    );
  }

  if (
    os.launchProfiles.some((profile) => profile.executionMode === 'browser') &&
    !env.webAssembly
  ) {
    reasons.push('WebAssembly indisponible dans ce navigateur.');
  }

  return { compatible: reasons.length === 0, reasons };
}
