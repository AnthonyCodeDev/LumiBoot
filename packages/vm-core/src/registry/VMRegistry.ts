import type { OSDefinition } from '@lumiboot/contracts';
import type { VMEngine } from '../contracts/VMEngine';
import type { VMInstance } from '../contracts/VMInstance';
import type { VMConfiguration } from '../contracts/VMConfiguration';
import { UnavailableProvider } from '../providers/UnavailableProvider';
import {
  checkEngineCompatibility,
  detectRuntimeEnvironment,
  type EngineCompatibilityResult,
  type RuntimeEnvironment,
} from '../compatibility/EngineCompatibility';

/**
 * Source de l'environnement d'exécution. Un objet statique suffit pour les
 * tests ; une fonction permet de réévaluer l'appareil à chaque résolution
 * (ex. capacités modifiées par une isolation d'origine croisée tardive).
 */
export type RuntimeEnvironmentProvider = RuntimeEnvironment | (() => RuntimeEnvironment);

/**
 * Sélection déterministe du moteur pour un système donné.
 *
 * L'UI n'appelle jamais un moteur directement : elle passe par `resolve()`,
 * `explain()` ou `start()`. Un moteur n'est retenu que s'il est RÉELLEMENT
 * compatible (prise en charge du système, architecture/CPU servie et prérequis
 * navigateur satisfaits). En l'absence de moteur compatible, le repli honnête
 * (`UnavailableProvider`) est utilisé et `explain()` donne la raison précise.
 */
export class VMRegistry {
  readonly #engines: VMEngine[];
  readonly #fallback: VMEngine;
  readonly #environment: RuntimeEnvironmentProvider | undefined;

  constructor(
    engines: readonly VMEngine[] = [],
    fallback: VMEngine = new UnavailableProvider(),
    environment?: RuntimeEnvironmentProvider,
  ) {
    this.#engines = [...engines];
    this.#fallback = fallback;
    this.#environment = environment;
  }

  register(engine: VMEngine): void {
    if (this.#engines.some((existing) => existing.id === engine.id)) return;
    this.#engines.push(engine);
  }

  get engines(): readonly VMEngine[] {
    return this.#engines;
  }

  /** @deprecated Utiliser `engines`. */
  get providers(): readonly VMEngine[] {
    return this.#engines;
  }

  /**
   * Retourne le premier moteur compatible (architecture/CPU + prérequis
   * navigateur), ou le repli honnête si aucun ne convient.
   */
  resolve(os: OSDefinition): VMEngine {
    return this.#firstCompatible(os) ?? this.#fallback;
  }

  /**
   * Raison précise de compatibilité, directement exploitable par l'UI : liste
   * vide si un moteur est compatible, sinon les motifs de rejet de chaque
   * candidat (architecture/CPU, WebAssembly, `canRun`). Sert à expliquer un
   * repli sans exposer la mécanique interne du registre.
   */
  explain(os: OSDefinition): EngineCompatibilityResult {
    const env = this.#readEnvironment();
    const results = this.#engines.map((engine) => ({
      engine,
      result: checkEngineCompatibility(engine, os, env),
    }));

    if (results.some(({ result }) => result.compatible)) {
      return { compatible: true, reasons: [] };
    }

    const reasons = results.flatMap(({ result }) => result.reasons);
    if (reasons.length === 0) {
      return { compatible: false, reasons: ['Aucun moteur de lancement n’est enregistré.'] };
    }
    return { compatible: false, reasons };
  }

  isFallback(engine: VMEngine): boolean {
    return engine.id === this.#fallback.id;
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    // `resolve()` impose déjà architecture/CPU et prérequis navigateur : un
    // moteur incompatible n'est jamais lancé, même via cet entrypoint.
    const engine = this.resolve(os);
    return configuration === undefined
      ? engine.start(os, mountTarget)
      : engine.start(os, mountTarget, configuration);
  }

  #firstCompatible(os: OSDefinition): VMEngine | undefined {
    const env = this.#readEnvironment();
    return this.#engines.find((engine) => checkEngineCompatibility(engine, os, env).compatible);
  }

  #readEnvironment(): RuntimeEnvironment {
    const environment = this.#environment;
    if (typeof environment === 'function') return environment();
    return environment ?? detectRuntimeEnvironment();
  }
}
