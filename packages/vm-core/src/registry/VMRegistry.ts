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

/** A function re-reads the device on every resolution. */
export type RuntimeEnvironmentProvider = RuntimeEnvironment | (() => RuntimeEnvironment);

/**
 * An engine is only selected when it is actually compatible; otherwise the
 * honest `UnavailableProvider` fallback is returned.
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

  /** First compatible engine, or the fallback. */
  resolve(os: OSDefinition): VMEngine {
    return this.#firstCompatible(os) ?? this.#fallback;
  }

  /** Empty `reasons` when compatible, otherwise the rejection reasons. */
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
      return { compatible: false, reasons: ['No launch engine is registered.'] };
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
    // `resolve()` enforces compatibility, so no incompatible engine is launched.
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
