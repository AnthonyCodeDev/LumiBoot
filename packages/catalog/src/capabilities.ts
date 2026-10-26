import type { OSDefinition } from '@lumiboot/contracts';
import { isEngineIntegrated } from './engines';

/**
 * Runtime environment capabilities. Centralized here so that no UI component
 * decides compatibility "on behalf" of a system.
 */
export interface BrowserCapabilities {
  webAssembly: boolean;
  webAssemblyStreaming: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}

function readGlobal(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name];
}

export function getBrowserCapabilities(): BrowserCapabilities {
  const wasm = readGlobal('WebAssembly') as typeof WebAssembly | undefined;
  return {
    webAssembly: typeof wasm === 'object' && typeof wasm.instantiate === 'function',
    webAssemblyStreaming: typeof wasm?.compileStreaming === 'function',
    sharedArrayBuffer: typeof readGlobal('SharedArrayBuffer') !== 'undefined',
    crossOriginIsolated: readGlobal('crossOriginIsolated') === true,
  };
}

export interface CompatibilityResult {
  supported: boolean;
  reasons: string[];
}

export function getCompatibility(os: OSDefinition, caps: BrowserCapabilities): CompatibilityResult {
  const reasons: string[] = [];

  if (os.availability === 'unavailable') {
    reasons.push('System marked as unavailable in the catalog.');
  }

  if (
    os.launchProfiles.some((profile) => profile.executionMode === 'browser') &&
    !caps.webAssembly
  ) {
    reasons.push('This browser does not provide WebAssembly.');
  }

  const integratedProfiles = os.launchProfiles.filter((profile) =>
    isEngineIntegrated(profile.engineId),
  );
  if (integratedProfiles.length === 0) {
    reasons.push('No compatible launch engine is integrated.');
  }

  return { supported: reasons.length === 0, reasons };
}
