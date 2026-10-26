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
 * Runtime environment source. A static object is enough for the tests; a
 * function allows re-evaluating the device on every resolution (e.g.
 * capabilities changed by a late cross-origin isolation).
 */
export type RuntimeEnvironmentProvider = RuntimeEnvironment | (() => RuntimeEnvironment);

/**
 * Deterministic engine selection for a given system.
 *
 * The UI never calls an engine directly: it goes through `resolve()`,
 * `explain()` or `start()`. An engine is only selected if it is ACTUALLY
 * compatible (system support, served architecture/CPU and browser prerequisites
 * satisfied). When no engine is compatible, the honest fallback
 * (`UnavailableProvider`) is used and `explain()` gives the precise reason.
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

  /** @deprecated Use `engines`. */
  get providers(): readonly VMEngine[] {
    return this.#engines;
  }

  /**
   * Returns the first compatible engine (architecture/CPU + browser
   * prerequisites), or the honest fallback if none fits.
   */
  resolve(os: OSDefinition): VMEngine {
    return this.#firstCompatible(os) ?? this.#fallback;
  }

  /**
   * Precise compatibility reason, directly usable by the UI: empty list if an
   * engine is compatible, otherwise the rejection reasons of every candidate
   * (architecture/CPU, WebAssembly, `canRun`). Used to explain a fallback
   * without exposing the internal mechanics of the registry.
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
    // `resolve()` already enforces architecture/CPU and browser prerequisites:
    // an incompatible engine is never launched, even through this entrypoint.
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
