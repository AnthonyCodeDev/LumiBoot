import type { OSDefinition } from '@lumiboot/contracts';
import type { VMEngine } from '../contracts/VMEngine';

export interface RuntimeEnvironment {
  webAssembly: boolean;
  crossOriginIsolated: boolean;
}

export interface EngineCompatibilityResult {
  compatible: boolean;
  reasons: string[];
}

/** Reads `globalThis` only, so `vm-core` stays usable in Node. */
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

/** An engine declaring no architecture cannot be contradicted on that criterion. */
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
