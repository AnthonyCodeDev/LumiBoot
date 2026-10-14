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
    boot(manifest: ImageManifest, mountElement: HTMLElement): Promise<void>;
    destroy(): void;
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
        return os.engineId === 'v86' && os.executionMode === 'browser';
    }

    async start(
        os: OSDefinition,
        mountElement: HTMLElement,
        _configuration?: VMConfiguration,
    ): Promise<VMInstance> {
        const manifest = await this.#resolveImage(os);
        const engine = await this.#loadEngine();
        await engine.boot(manifest, mountElement);

        const listeners = new Set<(event: SessionEvent) => void>();
        const emit = (event: SessionEvent): void => {
            for (const listener of listeners) listener(event);
        };

        return {
            id: createSessionId(),
            providerId: this.id,
            systemId: os.id,
            async stop(): Promise<void> {
                engine.destroy();
                emit({ type: 'state', state: 'stopped' });
            },
            async dispose(): Promise<void> {
                listeners.clear();
                engine.destroy();
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
