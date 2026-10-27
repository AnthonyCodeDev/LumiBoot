import {
  VMRegistry,
  type EngineCompatibilityResult,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import type { OSDefinition } from '@lumiboot/contracts';

/**
 * v86 capabilities mirrored for the UI, because the real provider is lazily
 * imported. A dedicated test keeps both definitions aligned.
 */
export const V86_LAZY_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
  // v86 reads `hda` through HTTP Range requests, never as a whole download.
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

class LazyV86Provider implements VMEngine {
  readonly id = 'v86';

  capabilities(): VMCapabilities {
    return V86_LAZY_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return os.launchProfiles.some(
      (profile) => profile.executionMode === 'browser' && profile.engineId === 'v86',
    );
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: Parameters<VMEngine['start']>[2],
  ): Promise<VMInstance> {
    const { V86Provider } = await import('@lumiboot/provider-v86');
    const provider = new V86Provider();
    const mountElement = mountTarget as HTMLElement;
    return configuration === undefined
      ? provider.start(os, mountElement)
      : provider.start(os, mountElement, configuration);
  }
}

/** Builds the application engine registry, with v86 loaded on demand. */
export function createRegistry(): VMRegistry {
  const registry = new VMRegistry();
  registry.register(new LazyV86Provider());

  return registry;
}

const compatibilityRegistry = createRegistry();

/**
 * Explains whether a system can run on this device: architecture served by the
 * engine and browser prerequisites satisfied. An empty reason list means yes.
 */
export function explainSystemCompatibility(os: OSDefinition): EngineCompatibilityResult {
  return compatibilityRegistry.explain(os);
}
