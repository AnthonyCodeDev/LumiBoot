import type { OSDefinition } from '@lumiboot/contracts';
import type { VMCapabilities } from './VMCapabilities';
import type { VMConfiguration } from './VMConfiguration';
import type { VMInstance } from './VMInstance';

/**
 * Contrat unique d'un moteur d'émulation/virtualisation. C'est la seule porte
 * d'entrée pour démarrer un système : l'UI ne connaît jamais `new V86(...)`.
 *
 * `canRun` doit rester déterministe et explicite ; les tests de compatibilité de
 * l'appareil sont gérés séparément par `EngineCompatibility`.
 */
export interface VMEngine {
  readonly id: string;
  capabilities(): VMCapabilities;
  canRun(os: OSDefinition): boolean;
  start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance>;
}

/** @deprecated Utiliser `VMEngine`. Conservé pour la compatibilité des imports. */
export type VMProvider = VMEngine;
