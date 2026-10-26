import type { OSDefinition } from '@lumiboot/contracts';
import type { VMEngine } from '../contracts/VMEngine';

/**
 * Device/deployment environment, evaluated before a launch.
 * Independent of the catalog: it allows testing compatibility without depending
 * on the UI or on a global read of the browser.
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
 * Detects browser prerequisites from `globalThis`, without ever touching the
 * DOM: `vm-core` stays independent of the interface and testable in Node. Used
 * as the registry default, so the UI does not have to provide the runtime
 * environment.
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
 * Checks that an engine can actually launch a system on the current device.
 * Deterministic and side-effect free: no "implicit" decision is made anywhere
 * else in the application.
 *
 * The architecture (the emulated CPU) is compared against the DECLARED
 * capabilities of the engine: v86 only declares `i386` and therefore rejects
 * `x86_64`/`arm64`. An engine that declares no architecture (empty
 * `architectures`) cannot be contradicted on this criterion — its capabilities
 * are simply not filled in.
 */
export function checkEngineCompatibility(
  engine: VMEngine,
  os: OSDefinition,
  env: RuntimeEnvironment,
): EngineCompatibilityResult {
  const reasons: string[] = [];
  const capabilities = engine.capabilities();

  if (!engine.canRun(os)) {
    reasons.push(`Engine "${engine.id}" does not support ${os.id}.`);
  }

  if (
    capabilities.architectures.length > 0 &&
    !capabilities.architectures.includes(os.architecture)
  ) {
    reasons.push(
      `Architecture ${os.architecture} is not supported by "${engine.id}" ` +
        `(declared support: ${capabilities.architectures.join(', ')}).`,
    );
  }

  if (
    os.launchProfiles.some((profile) => profile.executionMode === 'browser') &&
    !env.webAssembly
  ) {
    reasons.push('WebAssembly is unavailable in this browser.');
  }

  return { compatible: reasons.length === 0, reasons };
}
