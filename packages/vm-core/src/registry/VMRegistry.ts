import type { OSDefinition } from '@lumiboot/contracts';
import type { VMEngine } from '../contracts/VMEngine';
import type { VMInstance } from '../contracts/VMInstance';
import type { VMConfiguration } from '../contracts/VMConfiguration';
import { UnavailableProvider } from '../providers/UnavailableProvider';

/**
 * Sélection déterministe du moteur pour un système donné.
 *
 * L'UI n'appelle jamais un moteur directement : elle passe par `resolve()` ou
 * `start()`. En l'absence de moteur compatible, le repli honnête
 * (`UnavailableProvider`) est utilisé.
 */
export class VMRegistry {
  readonly #engines: VMEngine[];
  readonly #fallback: VMEngine;

  constructor(engines: readonly VMEngine[] = [], fallback: VMEngine = new UnavailableProvider()) {
    this.#engines = [...engines];
    this.#fallback = fallback;
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

  resolve(os: OSDefinition): VMEngine {
    return this.#engines.find((engine) => engine.canRun(os)) ?? this.#fallback;
  }

  isFallback(engine: VMEngine): boolean {
    return engine.id === this.#fallback.id;
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    const engine = this.resolve(os);
    return configuration === undefined
      ? engine.start(os, mountTarget)
      : engine.start(os, mountTarget, configuration);
  }
}
