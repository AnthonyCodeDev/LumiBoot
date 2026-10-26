import {
  VMRegistry,
  type EngineCompatibilityResult,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import type { OSDefinition } from '@lumiboot/contracts';

/**
 * v86 engine capabilities as the UI must know them.
 *
 * SHARED SOURCE: these values are aligned exactly with
 * `V86Provider.capabilities()` (`@lumiboot/provider-v86`). The real provider is
 * loaded lazily (dynamic import when a session starts), so it cannot be imported
 * here without breaking the bundle split. The alignment guarantee is provided by
 * a dedicated test (`registry.test.ts`) that compares these capabilities with the
 * real `V86Provider`; any divergence fails the suite.
 *
 * `ramSnapshots`/`diskSnapshots` stay `false`: `VMInstance` exposes NO snapshot
 * entry point, so the UI must never advertise a feature that does not exist
 * (reported by batch A).
 */
export const V86_LAZY_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
  // v86 reads `hda` through HTTP Range requests (`hda.async`): the disk is never
  // downloaded as a whole. Aligned with `V86Provider` (`partialDownload`).
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

/**
 * Builds the application engine registry.
 *
 * The v86 engine is loaded on demand to keep the initial bundle light and to
 * clearly separate the React shell from the emulation code.
 */
export function createRegistry(): VMRegistry {
  const registry = new VMRegistry();
  registry.register(new LazyV86Provider());

  return registry;
}

/**
 * Registry dedicated to compatibility checks (profile / architecture /
 * WebAssembly resolution). It shares the SAME capability source as the session
 * registry (`V86_LAZY_CAPABILITIES`), so the UI cannot contradict the engine
 * actually in use.
 */
const compatibilityRegistry = createRegistry();

/**
 * Explains whether a system can really be launched on the current device: an
 * architecture/CPU served by the engine and browser prerequisites satisfied.
 * An empty reason list means compatible. Single source for the launch button
 * (see `lib/launch.ts`), so a wrong architecture is refused explicitly instead of
 * failing at boot.
 */
export function explainSystemCompatibility(os: OSDefinition): EngineCompatibilityResult {
  return compatibilityRegistry.explain(os);
}
