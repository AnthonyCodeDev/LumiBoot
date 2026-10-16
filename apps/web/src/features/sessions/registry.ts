import {
  VMRegistry,
  type EngineCompatibilityResult,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import type { OSDefinition } from '@lumiboot/contracts';

/**
 * Capacités du moteur v86 telles que l'UI doit les connaître.
 *
 * SOURCE COMMUNE : ces valeurs sont alignées à l'identique sur
 * `V86Provider.capabilities()` (`@lumiboot/provider-v86`). Le provider réel est
 * chargé paresseusement (import dynamique au démarrage d'une session) : on ne
 * peut donc pas l'importer ici sans casser la séparation du bundle. La garantie
 * d'alignement est assurée par un test dédié (`registry.test.ts`) qui compare
 * ces capacités à celles du `V86Provider` réel ; toute divergence fait échouer
 * la suite.
 *
 * `ramSnapshots`/`diskSnapshots` restent `false` : `VMInstance` n'expose AUCUN
 * point d'entrée de snapshot, donc l'UI ne doit jamais annoncer une fonction
 * qui n'existe pas (signalé par le lot A).
 */
export const V86_LAZY_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: false,
  diskSnapshots: false,
  // v86 lit `hda` par requêtes HTTP Range (`hda.async`) : le disque n'est jamais
  // téléchargé en entier. Aligné sur `V86Provider` (`partialDownload`).
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

/**
 * Registre dédié aux vérifications de compatibilité (résolution de profil /
 * architecture / WebAssembly). Il partage la MÊME source de capacités que le
 * registre de session (`V86_LAZY_CAPABILITIES`), donc l'UI ne peut pas
 * contredire le moteur réellement utilisé.
 */
const compatibilityRegistry = createRegistry();

/**
 * Explique si un système peut réellement être lancé sur l'appareil courant :
 * architecture/CPU servie par le moteur et prérequis navigateur satisfaits.
 * Liste de motifs vide = compatible. Sert de source unique au bouton de
 * lancement (voir `lib/launch.ts`) pour refuser explicitement une mauvaise
 * architecture plutôt que d'échouer au démarrage.
 */
export function explainSystemCompatibility(os: OSDefinition): EngineCompatibilityResult {
  return compatibilityRegistry.explain(os);
}
