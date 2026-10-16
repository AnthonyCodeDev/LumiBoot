import { VMRegistry, type VMCapabilities, type VMEngine, type VMInstance } from '@lumiboot/vm-core';
import type { OSDefinition } from '@lumiboot/contracts';

const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: true,
  diskSnapshots: true,
  // v86 lit `hda` par requêtes HTTP Range (`hda.async`) : le disque n'est jamais
  // téléchargé en entier. Cette copie locale des capacités doit rester alignée
  // sur `V86Provider` (`V86_CAPABILITIES.partialDownload`).
  partialDownload: true,
  resumable: false,
  configurableMemory: true,
};

class LazyV86Provider implements VMEngine {
  readonly id = 'v86';

  capabilities(): VMCapabilities {
    return V86_CAPABILITIES;
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
 * Construit le registre de moteurs de l'application.
 *
 * Le moteur v86 est chargé à la demande afin de garder le bundle initial léger
 * et de séparer clairement le shell React du code d'émulation.
 */
export function createRegistry(): VMRegistry {
  const registry = new VMRegistry();
  registry.register(new LazyV86Provider());

  return registry;
}
