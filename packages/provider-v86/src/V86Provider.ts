import type { OSDefinition, SessionEvent } from '@lumiboot/contracts';
import {
  VMError,
  createSessionId,
  type VMConfiguration,
  type VMCapabilities,
  type VMEngine,
  type VMInstance,
} from '@lumiboot/vm-core';
import { resolveImage, type ImageManifest } from '@lumiboot/vm-assets';

export const V86_PROVIDER_ID = 'v86';

/**
 * Surface minimale de la bibliothèque v86 réellement utilisée par l'adapter.
 * Injectable pour rester testable sans télécharger v86.
 */
export interface V86Engine {
  boot(manifest: ImageManifest, mountElement: HTMLElement, options?: V86BootOptions): Promise<void>;
  destroy(): void;
}

export interface V86BootOptions {
  signal?: AbortSignal;
  configuration?: VMConfiguration;
}

export type V86EngineLoader = () => Promise<V86Engine>;
export type V86ImageResolver = (os: OSDefinition) => Promise<ImageManifest> | ImageManifest;

const V86_CAPABILITIES: VMCapabilities = {
  runtime: 'browser',
  architectures: ['i386'],
  ramSnapshots: true,
  diskSnapshots: true,
  partialDownload: false,
  resumable: false,
  configurableMemory: true,
};

/** Chargeur par défaut : ne fait rien tant que le Lot 1 n'a pas branché v86. */
const defaultEngineLoader: V86EngineLoader = async () => {
  throw new VMError('NOT_IMPLEMENTED', 'La bibliothèque v86 sera chargée au Lot 1.');
};

export interface V86ProviderOptions {
  loadEngine?: V86EngineLoader;
  resolveImage?: V86ImageResolver;
}

/**
 * Moteur navigateur pour le x86 32 bits (Debian 12 i386).
 *
 * IMPORTANT : ce moteur n'est PAS enregistré dans le registre par défaut tant que
 * l'intégration réelle (Lot 1) n'est pas terminée. Il est isolé et chargé
 * paresseusement, sans dépendance de l'UI à v86.
 */
export class V86Provider implements VMEngine {
  readonly id = V86_PROVIDER_ID;
  readonly #loadEngine: V86EngineLoader;
  readonly #resolveImage: V86ImageResolver;

  constructor(options: V86ProviderOptions = {}) {
    this.#loadEngine = options.loadEngine ?? defaultEngineLoader;
    this.#resolveImage = options.resolveImage ?? resolveImage;
  }

  capabilities(): VMCapabilities {
    return V86_CAPABILITIES;
  }

  canRun(os: OSDefinition): boolean {
    return os.launchProfiles.some(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
  }

  #mergeConfiguration(
    launchConfiguration: Partial<VMConfiguration> | undefined,
    runtimeConfiguration: Partial<VMConfiguration> | undefined,
  ): VMConfiguration | undefined {
    const merged: Record<string, unknown> = {};

    const assign = (configuration: Partial<VMConfiguration> | undefined): void => {
      if (!configuration) return;
      if (configuration.memoryMiB !== undefined) merged.memoryMiB = configuration.memoryMiB;
      if (configuration.vgaMemoryMiB !== undefined)
        merged.vgaMemoryMiB = configuration.vgaMemoryMiB;
      if (configuration.bootDevice !== undefined) merged.bootDevice = configuration.bootDevice;
      if (configuration.extra !== undefined) merged.extra = configuration.extra;
    };

    assign(launchConfiguration);
    assign(runtimeConfiguration);
    if (runtimeConfiguration?.signal !== undefined) merged.signal = runtimeConfiguration.signal;

    return Object.keys(merged).length === 0 ? undefined : (merged as VMConfiguration);
  }

  async start(
    os: OSDefinition,
    mountElement: HTMLElement,
    configuration?: VMConfiguration,
  ): Promise<VMInstance> {
    const launchProfile = os.launchProfiles.find(
      (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
    );
    if (!launchProfile) {
      throw new VMError(
        'ENGINE_NOT_INTEGRATED',
        `Le moteur « v86 » n'est pas intégré pour « ${os.id} ».`,
        {
          systemId: os.id,
        },
      );
    }

    const manifest = await this.#resolveImage(os);
    const engine = await this.#loadEngine();
    const bootConfiguration = this.#mergeConfiguration(
      launchProfile.configuration as Partial<VMConfiguration> | undefined,
      configuration,
    );

    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      try {
        engine.destroy();
      } catch {
        /* nettoyage best-effort */
      }
    };

    if (configuration?.signal?.aborted) {
      cleanup();
      throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, { systemId: os.id });
    }

    const abortHandler = (): void => cleanup();
    configuration?.signal?.addEventListener('abort', abortHandler, { once: true });

    try {
      await engine.boot(manifest, mountElement, {
        ...(configuration?.signal !== undefined ? { signal: configuration.signal } : {}),
        ...(bootConfiguration !== undefined ? { configuration: bootConfiguration } : {}),
      });
      if (configuration?.signal?.aborted) {
        cleanup();
        throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
          systemId: os.id,
        });
      }
    } catch (error) {
      cleanup();
      if (configuration?.signal?.aborted) {
        throw new VMError('START_FAILED', `Démarrage annulé pour « ${os.id} ».`, {
          systemId: os.id,
          cause: error,
        });
      }
      throw error instanceof VMError
        ? error
        : new VMError('START_FAILED', `Le moteur v86 n'a pas pu démarrer « ${os.id} ».`, {
            systemId: os.id,
            cause: error,
          });
    } finally {
      configuration?.signal?.removeEventListener('abort', abortHandler);
    }

    const listeners = new Set<(event: SessionEvent) => void>();
    let closed = false;
    const emit = (event: SessionEvent): void => {
      if (closed) return;
      for (const listener of listeners) listener(event);
    };

    return {
      id: createSessionId(),
      providerId: this.id,
      systemId: os.id,
      async stop(): Promise<void> {
        cleanup();
        emit({ type: 'state', state: 'stopped' });
        closed = true;
      },
      async dispose(): Promise<void> {
        cleanup();
        closed = true;
        listeners.clear();
      },
      subscribe(listener): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }
}
