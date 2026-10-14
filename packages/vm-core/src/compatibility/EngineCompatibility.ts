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
 * Vérifie qu'un moteur peut réellement lancer un système sur l'appareil actuel.
 * Déterministe et sans effet de bord : aucune décision « implicite » n'est prise
 * ailleurs dans l'application.
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

  if (!capabilities.architectures.includes(os.architecture)) {
    reasons.push(`Architecture ${os.architecture} non prise en charge par « ${engine.id} ».`);
  }

  if (
    os.launchProfiles.some((profile) => profile.executionMode === 'browser') &&
    !env.webAssembly
  ) {
    reasons.push('WebAssembly indisponible dans ce navigateur.');
  }

  return { compatible: reasons.length === 0, reasons };
}
