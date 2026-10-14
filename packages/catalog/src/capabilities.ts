import type { OSDefinition } from '@lumiboot/contracts';
import { isEngineIntegrated } from './engines';

/**
 * Capacités de l'environnement d'exécution. Centralisées ici pour qu'aucun
 * composant d'interface ne décide de la compatibilité « au nom » d'un système.
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
    reasons.push('Système marqué comme indisponible dans le catalogue.');
  }

  if (os.executionMode === 'browser' && !caps.webAssembly) {
    reasons.push('Ce navigateur ne fournit pas WebAssembly.');
  }

  if (!isEngineIntegrated(os.engineId)) {
    reasons.push(`Moteur « ${os.engineId} » non intégré.`);
  }

  return { supported: reasons.length === 0, reasons };
}
