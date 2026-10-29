import {
  VMRegistry,
  type EngineCompatibilityResult,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import type { OSDefinition } from '@lumiboot/contracts';

/** Mirrors the v86 capabilities for the UI; the real provider is lazily imported. */
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

export const V64_LAZY_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['x86_64'],
  ramSnapshots: false,
  diskSnapshots: false,
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

class LazyV64Provider implements VMEngine {
  readonly id = 'v64';

  capabilities(): VMCapabilities {
    return V64_LAZY_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return (
      os.architecture === 'x86_64' &&
      os.launchProfiles.some(
        (profile) => profile.executionMode === 'browser' && profile.engineId === 'v64',
      )
    );
  }

  async start(
    os: OSDefinition,
    mountTarget: unknown,
    configuration?: Parameters<VMEngine['start']>[2],
  ): Promise<VMInstance> {
    const { V64Provider } = await import('@lumiboot/provider-v64');
    const provider = new V64Provider();
    return configuration === undefined
      ? provider.start(os, mountTarget)
      : provider.start(os, mountTarget, configuration);
  }
}

/** Builds the application engine registry, with both browser engines loaded on demand. */
export function createRegistry(): VMRegistry {
  const registry = new VMRegistry();
  registry.register(new LazyV86Provider());
  registry.register(new LazyV64Provider());

  return registry;
}

const compatibilityRegistry = createRegistry();

/** Whether a system can run on this device: engine architecture and browser prerequisites. */
export function explainSystemCompatibility(os: OSDefinition): EngineCompatibilityResult {
  return compatibilityRegistry.explain(os);
}
